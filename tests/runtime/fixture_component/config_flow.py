"""Config flow for the runtime-only registry fixture."""

from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult


class RuntimeFixtureConfigFlow(ConfigFlow, domain="optim_runtime_fixture"):
    """Create one fixture entry used to own test devices."""

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if self._async_current_entries():
            return self.async_abort(reason="already_configured")
        if user_input is not None:
            return self.async_create_entry(title="Runtime Fixture", data={})
        return self.async_show_form(step_id="user")
