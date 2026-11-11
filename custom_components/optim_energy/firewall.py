"""Websocket firewall for non-admin Optim Energy users."""

from __future__ import annotations

from collections.abc import Iterable
import logging
from typing import Any

from homeassistant.auth.models import User
from homeassistant.components import websocket_api
from homeassistant.components.websocket_api import ActiveConnection
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN
from .tenancy import TenancyManager

_LOGGER = logging.getLogger(__name__)

# Commands the frontend needs before it has loaded the portal. They contain no
# tenant device data. The custom whoami command is the only portal-specific
# command needed for an unassigned account to explain why it cannot continue.
BOOT_COMMANDS = {
    "ping",
    "supported_features",
    "get_config",
    "subscribe_bootstrap_integrations",
    "frontend/get_user_data",
    "frontend/set_user_data",
    "frontend/subscribe_user_data",
    "frontend/unsubscribe_user_data",
    "frontend/get_themes",
    "frontend/get_translations",
    "frontend/get_panels",
    "frontend/log_ui_action",
    "frontend/subscribe_system_data",
    "frontend/unsubscribe_system_data",
    "auth/current_user",
    f"{DOMAIN}/whoami",
}

READ_COMMANDS = {
    "get_states",
    "subscribe_entities",
    "subscribe_events",
    "unsubscribe_events",
    "recorder/info",
    "get_services",
    "get_panels",
    "get_themes",
    "get_translations",
    f"{DOMAIN}/tree/get",
    f"{DOMAIN}/user/list",
    f"{DOMAIN}/client/list",
    f"{DOMAIN}/registry/list",
}

PORTAL_DASHBOARDS = {
    "energy-locations",
    "energy-home",
    "energy-groups",
    "energy-controls",
    "energy-devices",
    "energy-reports",
    "energy-alerts",
    "energy-setup",
}

SAFE_SERVICE_PAIRS = {
    ("homeassistant", "turn_on"),
    ("homeassistant", "turn_off"),
    ("homeassistant", "toggle"),
    ("light", "turn_on"),
    ("light", "turn_off"),
    ("light", "toggle"),
    ("switch", "turn_on"),
    ("switch", "turn_off"),
    ("switch", "toggle"),
    ("fan", "turn_on"),
    ("fan", "turn_off"),
    ("fan", "toggle"),
    ("cover", "open_cover"),
    ("cover", "close_cover"),
    ("cover", "stop_cover"),
    ("cover", "set_cover_position"),
    ("climate", "turn_on"),
    ("climate", "turn_off"),
    ("climate", "set_temperature"),
    ("climate", "set_hvac_mode"),
    ("media_player", "turn_on"),
    ("media_player", "turn_off"),
    ("media_player", "media_play"),
    ("media_player", "media_pause"),
    ("media_player", "media_stop"),
    ("media_player", "volume_set"),
    ("media_player", "volume_mute"),
    ("automation", "turn_on"),
    ("automation", "turn_off"),
    ("automation", "toggle"),
    ("script", "turn_on"),
    ("script", "turn_off"),
    ("script", "toggle"),
    ("scene", "turn_on"),
    ("vacuum", "start"),
    ("vacuum", "pause"),
    ("vacuum", "stop"),
    ("vacuum", "return_to_base"),
    ("humidifier", "turn_on"),
    ("humidifier", "turn_off"),
    ("humidifier", "toggle"),
    ("water_heater", "turn_on"),
    ("water_heater", "turn_off"),
    ("button", "press"),
    ("persistent_notification", "dismiss"),
}


def _ids(value: Any) -> list[str] | None:
    if isinstance(value, str):
        return [value]
    if isinstance(value, (list, tuple, set)) and all(isinstance(x, str) for x in value):
        return list(value)
    return None


def _all_entities_allowed(user: User, entity_ids: Iterable[str]) -> bool:
    return all(user.permissions.check_entity(entity_id, "read") for entity_id in entity_ids)


def _deny(connection: ActiveConnection, msg: dict[str, Any], reason: str) -> None:
    """Reject a command without invoking its registered handler."""
    msg_id = msg.get("id")
    if isinstance(msg_id, int):
        connection.last_id = msg_id
    connection.send_error(
        msg_id,  # type: ignore[arg-type]
        websocket_api.ERR_UNAUTHORIZED,
        f"Optim Energy denied this command: {reason}",
        translation_domain=DOMAIN,
        translation_key="command_denied",
    )


class WebsocketFirewall:
    """Intercept every websocket message, including commands registered later."""

    def __init__(
        self,
        hass: HomeAssistant,
        manager: TenancyManager,
        *,
        audit: bool = False,
    ) -> None:
        self.hass = hass
        self.manager = manager
        self.audit = audit
        self._original: Any = None
        self._installed = False

    @callback
    def install(self) -> None:
        """Install the dispatch guard and verify it is active."""
        if self._installed:
            return
        original = ActiveConnection.async_handle
        while getattr(original, "__optim_energy_firewall__", False):
            original = getattr(original, "__optim_energy_original__", None)
        if original is None:
            raise RuntimeError("Optim Energy websocket firewall lost its original handler")
        self._original = original

        @callback
        def guarded_handle(connection: ActiveConnection, msg: dict[str, Any]) -> None:
            if isinstance(msg, dict) and not self.manager.is_root(connection.user):
                command = msg.get("type")
                if command == "repairs/list_issues":
                    connection.send_result(msg.get("id"), {"issues": []})
                    return
                if command == "config/entity_registry/list_for_display":
                    try:
                        entities = self.manager.registry_list(connection.user, "entity", None)
                    except Exception:
                        entities = []
                    connection.send_result(
                        msg.get("id"), {"entity_categories": {}, "entities": entities}
                    )
                    return
            allowed, reason = self.decision(connection, msg)
            if not allowed:
                if self.audit:
                    _LOGGER.warning(
                        "Optim Energy audit: would deny %s for %s (%s)",
                        msg.get("type"),
                        connection.user.name,
                        reason,
                    )
                else:
                    _LOGGER.warning(
                        "Optim Energy denied websocket command %s for %s: %s",
                        msg.get("type"),
                        connection.user.name,
                        reason,
                    )
                    _deny(connection, msg, reason)
                    return
            original(connection, msg)

        guarded_handle.__optim_energy_firewall__ = True  # type: ignore[attr-defined]
        guarded_handle.__optim_energy_original__ = original  # type: ignore[attr-defined]
        ActiveConnection.async_handle = guarded_handle
        if ActiveConnection.async_handle is not guarded_handle:
            raise RuntimeError("Optim Energy websocket firewall did not install")
        self._installed = True
        _LOGGER.info(
            "Optim Energy websocket firewall active%s",
            " in audit mode" if self.audit else "",
        )

    @callback
    def uninstall(self) -> None:
        """Remove only this integration's guard."""
        current = ActiveConnection.async_handle
        if self._installed and getattr(current, "__optim_energy_firewall__", False):
            ActiveConnection.async_handle = self._original
            self._installed = False

    def decision(self, connection: ActiveConnection, msg: Any) -> tuple[bool, str]:
        """Return whether a websocket message may reach its handler."""
        if not isinstance(msg, dict):
            return True, ""
        user = connection.user
        if self.manager.is_root(user):
            return True, ""
        command = msg.get("type")
        if not isinstance(command, str):
            return True, ""
        role = self.manager.role(user)
        if command in BOOT_COMMANDS:
            return True, ""
        if role is None:
            return False, "account is not assigned to a client"

        if command == "call_service":
            domain, service = msg.get("domain"), msg.get("service")
            if (domain, service) not in SAFE_SERVICE_PAIRS:
                return False, f"service {domain}.{service} is not allowed in the portal"
            return True, ""

        if command == "history/history_during_period":
            entity_ids = _ids(msg.get("entity_ids"))
            if entity_ids is None:
                return False, "history requires an explicit entity list"
            if not _all_entities_allowed(user, entity_ids):
                return False, "history includes an entity outside this account"
            return True, ""

        if command == "recorder/statistics_during_period":
            statistic_ids = _ids(msg.get("statistic_ids"))
            if statistic_ids is None:
                return False, "statistics require an explicit entity list"
            if not _all_entities_allowed(user, statistic_ids):
                return False, "statistics include an entity outside this account"
            return True, ""

        if command == "logbook/get_events":
            entity_ids = _ids(msg.get("entity_ids"))
            if entity_ids is None:
                return False, "logbook requires an explicit entity list"
            if not _all_entities_allowed(user, entity_ids):
                return False, "logbook includes an entity outside this account"
            return True, ""

        if command == "lovelace/config":
            url_path = msg.get("url_path")
            # Home Assistant sends no url_path for the instance default panel.
            # The integration sets that default to the tenant Locations page.
            if url_path in PORTAL_DASHBOARDS or url_path is None:
                return True, ""
            return False, "only the bundled portal dashboards are available"

        if command in READ_COMMANDS:
            return True, ""

        if command.startswith(f"{DOMAIN}/"):
            # The custom command handlers perform their own role checks.
            return True, ""

        return False, "command is not allowlisted for tenant accounts"


REST_ALLOWLIST = {
    "/api/",
    "/api/config",
    "/api/websocket",
}


class RestFirewall:
    """Block raw REST API access for authenticated tenant accounts.

    Home Assistant starts aiohttp before custom integrations are set up, so the
    frozen middleware chain must be extended in place. The startup self-test
    verifies that the exact guard callable is in the active handler chain.
    """

    def __init__(self, hass: HomeAssistant, manager: TenancyManager, *, audit: bool = False) -> None:
        self.hass = hass
        self.manager = manager
        self.audit = audit
        self._middleware: Any = None
        self._original_handlers: Any = None

    async def install(self) -> None:
        """Install aiohttp middleware into the active application chain."""
        from aiohttp import web

        if not hasattr(self.hass, "http") or self.hass.http is None:
            raise RuntimeError("Home Assistant HTTP server is not initialized")
        app = self.hass.http.app

        @web.middleware
        async def tenant_rest_guard(request: Any, handler: Any) -> Any:
            path = request.path
            if not path.startswith("/api/") or path in REST_ALLOWLIST:
                return await handler(request)
            if path.startswith("/api/auth/"):
                return await handler(request)
            auth = request.headers.get("Authorization", "")
            if not auth.lower().startswith("bearer "):
                # Let Home Assistant's auth layer answer unauthenticated
                # requests. Login and signed webhook flows stay outside this
                # bearer-token tenant guard.
                return await handler(request)
            token = self.hass.auth.async_validate_access_token(auth[7:].strip())
            user = token.user if token is not None else None
            if user is None or self.manager.is_root(user):
                return await handler(request)
            if self.audit:
                _LOGGER.warning(
                    "Optim Energy audit: would deny REST %s %s for %s",
                    request.method,
                    path,
                    user.name,
                )
                return await handler(request)
            return web.json_response(
                {"code": "unauthorized", "message": "REST API is not available to tenant accounts"},
                status=403,
            )

        tenant_rest_guard.__optim_energy_rest__ = True  # type: ignore[attr-defined]
        self._middleware = tenant_rest_guard
        handlers = getattr(app, "_middlewares_handlers", None)
        if handlers is not None:
            # Application.pre_freeze() has already run. Appending a new-style
            # middleware makes it the outermost wrapper while preserving all
            # Home Assistant middleware.
            self._original_handlers = handlers
            app._middlewares_handlers = (*handlers, (tenant_rest_guard, True))
            app._run_middlewares = True  # type: ignore[attr-defined]
        else:
            app.middlewares.insert(0, tenant_rest_guard)
        if not any(
            middleware is tenant_rest_guard
            for middleware, _new_style in (getattr(app, "_middlewares_handlers", None) or ())
        ) and tenant_rest_guard not in app.middlewares:
            raise RuntimeError("Optim Energy REST guard did not install")
        _LOGGER.info(
            "Optim Energy REST guard active%s",
            " in audit mode" if self.audit else "",
        )

    def uninstall(self) -> None:
        """Remove the guard from the active middleware chain."""
        if self._middleware is None or not hasattr(self.hass, "http") or self.hass.http is None:
            return
        app = self.hass.http.app
        if self._original_handlers is not None:
            app._middlewares_handlers = self._original_handlers  # type: ignore[attr-defined]
            self._original_handlers = None
        elif self._middleware in app.middlewares:
            app.middlewares.remove(self._middleware)
        self._middleware = None
