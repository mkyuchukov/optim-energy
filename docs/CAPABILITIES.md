# Who may call what

Every `optim_energy/*` websocket command and the roles that may call it. A test (`tests/test_tenancy.py`) fails if a command is registered but missing here, so a new command cannot ship without a decision.

- **Root** is a real Home Assistant administrator. Root may pass `client` to act for any client.
- **Client admin** and **User** are non-admin Home Assistant accounts with a portal role. "Own" means the caller's own client; for a User, the locations they are assigned to.
- An account with no portal role can call `whoami` only.

| Command | Root | Client admin | User |
|---|---|---|---|
| `whoami` | yes | yes | yes |
| `tree/get` | any client | own client | own locations |
| `tree/save` | whole tree | `prices` only, own locations | no |
| `registry/list` | any client | own client | own locations |
| `client/list` | all | own | own |
| `client/create` | yes | no | no |
| `client/update` | yes | no | no |
| `client/delete` | yes | no | no |
| `client/set_locations` | yes | no | no |
| `location/catalog` | yes | no | no |
| `location/save` | yes | no | no |
| `location/delete` | yes, when empty | no | no |
| `group/save` | any client | own locations | no |
| `group/delete` | any client | own groups | no |
| `device/assign` | any device, any client, or unassign | own devices to own locations and groups | no |
| `migration/plan` | yes | no | no |
| `migration/apply` | yes, once | no | no |
| `user/list` | any client | own client | no |
| `user/create` | any role | Users only, own locations | no |
| `user/update` | yes | own Users, never an HA admin or client admin | no |
| `user/delete` | yes | own Users, never an HA admin or client admin | no |
| `entity/get` | yes | own entities | no |
| `entity/update` | yes | own entities, own areas and labels | no |
| `device/update` | yes | rename own devices | no |
| `automation/get` | yes | automations its own commands created | no |
| `automation/save_schedule` | yes | own switches; edits only automations it created | no |
| `automation/save_alert` | yes | alert rules it created | no |
| `automation/delete` | yes | automations it created | no |
| `helper/threshold/save` | yes | own sensors; edits only rules it created | no |
| `helper/delete` | yes | alert rules it created | no |
| `helper/sum/save` | yes | Sum of a virtual device root gave the client, own members | no |
| `helper/sum/delete` | yes | Sum of a virtual device root gave the client | no |
| `bill/read` | yes | yes, within quota | yes, within quota |

## Tree keys

`tree/save` from a client admin changes `prices` and nothing else. These keys decide permissions or ownership and are written only by root or by the commands above: `places`, `placed`, `parents`, `main`, `mains`, `virtual`, `sums`, `automations`, `known`, `kept`, `kinds`, `alarms`, `notify`.

## Ownership

Alert-rule helpers and automations are recorded per client in the tenancy store (`owned`) when a command creates them. A client can only change or delete what is recorded for it. If the record cannot be saved, the new helper or automation is removed again.
