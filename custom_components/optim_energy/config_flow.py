"""Config flow for Optim Energy."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .const import CONF_SITE_NAME, DOMAIN


class OptimEnergyConfigFlow(ConfigFlow, domain=DOMAIN):
    """Set up Optim Energy for one client site."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Create the single Optim Energy entry."""
        if self._async_current_entries():
            return self.async_abort(reason="already_configured")

        errors: dict[str, str] = {}
        if user_input is not None:
            site_name = user_input[CONF_SITE_NAME].strip()
            if not site_name:
                errors[CONF_SITE_NAME] = "required"
            else:
                return self.async_create_entry(
                    title=site_name,
                    data={CONF_SITE_NAME: site_name},
                )

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_SITE_NAME, default="Optim Energy"): str,
                }
            ),
            errors=errors,
        )
