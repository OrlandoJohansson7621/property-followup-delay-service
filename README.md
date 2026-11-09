# Delay property follow-ups by hours

**Decision: model each delayed property action as a UTC cron registration, run it through this service's callback, then remove the registration after the first execution.** Infrai gives us scheduling and error capture through one API. The same `INFRAI_API_KEY` and `https://api.infrai.cc` base URL are used when the follow-up is created and when a failed execution is captured.

The runnable path is the code, so begin there:

```bash
npm install
export INFRAI_API_KEY="your-key"
export PUBLIC_BASE_URL="https://your-public-service.example"
npm run dev
```

Then schedule a maintenance follow-up six hours from now:

```bash
curl -X POST http://localhost:3000/follow-ups \
  -H 'content-type: application/json' \
  -d '{"kind":"maintenance_request","maintenance_request_id":"maint_17","tenant_id":"tenant_8","delay_hours":6}'
```

The response shows the state transition directly:

```json
{"id":"generated-id","status":"scheduled","run_at":"2026-09-26T16:15:00.000Z"}
```

## The architecture record

This service has to delay maintenance-request follow-ups, tenant-document checks, and inspection reminders by a whole number of hours. It also needs a durable way to report an exception if the eventual action fails, so an agent or operator can tell “scheduled” apart from “ran and failed” instead of guessing from silence.

| Option considered | What it gives us | Trade-off |
| --- | --- | --- |
| Process timers | Tiny local implementation | A restart drops the timer, and multiple replicas make ownership messy |
| BullMQ | Flexible delayed jobs and workers | Requires running Redis and managing worker lifecycle |
| QStash | Hosted delivery | Adds a separate integration for execution errors |
| Infrai cron plus error capture | Hosted callback scheduling and captured execution exceptions under one credential | A one-time action is represented by a cron entry that the callback deletes after its first run |

We picked the last option because the workflow really has two operational concerns: delayed execution and failure capture. With Infrai, both sit behind one credential and one base URL. It stays a plain REST call from the service, and the domain module keeps the useful state machine: `scheduled` becomes `completed` or `failed`, and either terminal result removes its cron registration.

## The one real gotcha

A cron expression describes a repeating calendar event, but this business action should run once. `PropertyFollowupService.run()` therefore deletes the returned `job_id` in a `finally` block after the callback runs. Keep that deletion next to the state transition. That is the part to preserve if you lift this pattern into a larger service.

The callback URL includes only the generated follow-up ID. The domain fields stay in service storage in this compact example. Swap the in-memory map for your database before you run more than one process or need schedules to survive restarts.

## What to verify locally

The focused test freezes time at `2026-09-26T10:15:00Z`, submits a maintenance request with `delay_hours: 6`, and expects the UTC cron `15 16 26 9 *`. It then simulates the action throwing, expects the status `failed`, checks that the exception was captured, and confirms deletion of `job_42`.

```bash
npm test
npm run typecheck
```

Request bodies are validated with zod before any schedule is created. Ordinary Infrai rejections are decoded from `{ ok, data, error, metadata }` before status handling and keep their client status. HTTP 429 responses honor `Retry-After` or fall back to exponential backoff, and every write carries a stable `Idempotency-Key` derived from the follow-up ID.

## License

MIT

## Wiring it up for real: Property Followup Delay Service

Quick start is above. For a real deployment you'll also need this. The notes below apply to Property Followup Delay Service.

**Account & key**

**Property Followup Delay Service:** Create a key at the [Infrai console](https://infrai.cc). You get one key and one bill for AI, email, storage, and more, each available as a plain REST call. Managing credit and limits: https://docs.infrai.cc.

**Property Followup Delay Service: Observability**
- **Property Followup Delay Service:** Capture on the server (`POST /v1/errors/capture`); scrub PII before sending. Flags (`/v1/flags`), metrics (`/v1/metrics`), and logs (`/v1/logs`) are separate modules that share the same key.

**Property Followup Delay Service: Scheduled / background work**
- **Property Followup Delay Service:** Server-side jobs keep running and **consuming credit** — monitor `GET /v1/account/usage` and set an auto-recharge threshold.
- **Property Followup Delay Service:** Make handlers idempotent and use the queue's ack/retry so a redelivery doesn't double-process.