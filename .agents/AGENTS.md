# Riaya Project Context (for AI)

This document is a compact project guide for AI assistants working on this repo.

## What This Project Is

- Riaya is an AI-powered healthcare appointment platform.
- The repo has **two TypeScript apps**:
  - `web/`: Next.js web app (frontend + API routes + DB layer). Package name in `package.json` is `web-ts`.
  - `voice/`: realtime bridge for Twilio phone calls, dashboard websocket streaming, and AI-assisted booking flow.
- High-level phone-booking flow:
  - Twilio hits `socket` `/incoming-call` → TwiML connects media stream; `ensureCallRow` and `ensurePersonRow` upsert DB rows in Next (cached by `callSid` / phone).
  - `TwilioSession` bridges Twilio audio ↔ OpenAI Realtime ↔ dashboard websocket.
  - AI tools call Next public/internal APIs (slots, external booking, person updates).
  - Admin dashboard in `web` listens to realtime call events over websocket.

## Core Tech Stack

### Frontend / Web App (`web/`)

- Next.js (App Router), React, TypeScript
- Tailwind CSS v4 + `tw-animate-css` + shadcn styles
- Radix/shadcn UI components
- SWR for data fetching/caching in client components
- Axios for HTTP client in services
- React Hook Form + Zod for form validation
- Better Auth for auth/session
- Drizzle ORM + PostgreSQL
- Biome for lint/format

### Realtime Backend (`socket/`)

- Node.js + Express + TypeScript
- `ws` WebSocket servers (Twilio stream + dashboard + WhatsApp admin)
- Twilio media stream handling
- Azure/OpenAI realtime integration
- Axios (`nextjsApi`) for calling Next API endpoints
- Pino logging

## Repo Structure

- `web/src/app`: Next app routes and API routes (`/api/...`)
- `web/src/components`: UI and feature components
- `web/src/services`: API service configuration. Orval generates fetchers and SWR hooks in `web/src/services/generated/*`.
- `web/src/services/types.ts`: app-level TS types (custom domain types).
- `web/src/db`: Drizzle schema, DB instance, seeds
- `web/src/lib`: shared utilities (`api-utils`, `person.ts`, auth helpers, SWR fetcher, etc.)
- `web/src/hooks`: custom React hooks (including realtime dashboard socket)
- `socket/src/server.ts`: HTTP + websocket entrypoint, `/incoming-call` webhook
- `socket/src/sessions/twilioSession.ts`: core phone ↔ AI ↔ dashboard session logic and tool handlers
- `socket/src/sessions/systemMessages.ts`: assistant behavior + function tool specs
- `socket/src/api/callsApi.ts`: internal Next `/api/calls` client (cached `ensureCallRow`)
- `socket/src/api/personsApi.ts`: Next `/api/persons` client (cached `ensurePersonRow`, `updatePersonRow`)
- `socket/src/types/index.ts`: realtime message and API-related types

## Package management

- Use **pnpm** for this repo (not npm or yarn): installs, adds, and scripts should go through `pnpm`.
- Examples: `pnpm install`, `pnpm add <pkg>`, `pnpm run <script>` from `web/` or `socket/` as needed.
- Schema changes: `pnpm db:push` from `web/` (Drizzle push, not migration files by default).

## Working Conventions (Important)

### 1) Generated API Client (`zod-to-openapi` + Orval)

- **API routes MUST register their schemas**: Every route in `web/src/app/api/**/route.ts` must call `registry.registerPath()` at the bottom to define its OpenAPI spec.
- **Never use `any`**: The OpenAPI schemas must be strictly typed! Use `drizzle-zod` schemas exported from `web/src/db/zod.ts` for all route responses and bodies. Never fallback to `z.any()`.
- **Use tags**: Always include a `tags` array (e.g., `tags: ["Patients"]`) in the registration. This splits the generated outputs cleanly by domain.
- **Regenerate after changes**: Whenever you add or update an API route, run `pnpm generate:api` in `web/` to regenerate the `openapi.json` and Orval fetchers, followed by `pnpm format` to format the generated code.

### 2) Types are explicit and centralized

- DB-backed types often derive from Drizzle (`InferSelectModel`) in `web/src/services/types.ts`.
- Add composed UI/API-friendly types there when reused in multiple places.
- Realtime message contracts are defined in `socket/src/types/index.ts`.

### 3) Validation with Zod

- API routes in `web/src/app/api/**/route.ts` validate query/body using `zod`.
- Forms use `react-hook-form` + `zodResolver`.
- Keep schema near the route/component that owns the validation.

### 4) SWR and API consumption

- Do NOT write manual Axios calls. Always use the Orval-generated SWR hooks and functions located in `web/src/services/generated/*`.
- **For fetching (GET)**: Use the generated SWR hooks (e.g., `useGetApiPatients()`) in client components.
- **For mutating (POST/PUT/DELETE/PATCH)**: Use the generated SWR mutation hooks (e.g., `usePostApiPatients()`). Call the returned `trigger(data)` function in your `onSubmit` handler, and run SWR's `mutate()` to revalidate cached queries upon success.

### 5) Tailwind + shadcn UI style

- Styling is utility-class driven with Tailwind.
- Prefer existing UI primitives from `web/src/components/ui/*`.
- Theme tokens and custom utilities live in `web/src/app/globals.css`.

### 6) API route style in Next

- Route handlers usually:
  - parse input with Zod
  - enforce auth/role with helpers from `web/src/lib/api-utils.ts` (`requireSession`, `requireDoctorProfile`, `requireAdmin`, `requireInternal`)
  - run Drizzle query/mutation
  - return typed JSON helper responses (`json`, `apiError`, `validationError`)

### 7) Realtime architecture rules

- `socket` manages websocket channels:
  - Twilio media stream (`/media-stream`)
  - Dashboard monitoring (`/dashboard`)
  - WhatsApp admin (`/whatsapp`)
- `twilioSession.ts` sends dashboard events (`call_start`, transcripts, function calls, booking status).
- `socket` calls Next API endpoints for doctor slots, external appointment creation, call persistence, and person upsert/update.
- Server-to-server routes use `requireInternal` + `x-internal-secret` header (`INTERNAL_API_SECRET` on both services).

### 8) Dashboard & Admin page layout structure

- When creating pages in `dashboard` or `admin` (e.g., under `web/src/app/(navbar)/dashboard/*` or `web/src/app/(navbar)/admin/*`), follow the existing structure.
- Keep `page.tsx` routes clean, lightweight wrappers that render feature components from `web/src/components/*`.
- Always wrap the page content in the appropriate layout wrapper (e.g., `<DashboardLayout title="...">` or `<AdminLayout title="...">`).
- Reference example (`web/src/app/(navbar)/dashboard/(verified)/patients/page.tsx`):
  ```tsx
  import PatientsList from "@/components/dashboard/patients/patients-list";
  import DashboardLayout from "@/components/layouts/dashboard-layout";

  export default function PatientsPage() {
  	return (
  		<DashboardLayout title="Patients">
  			<PatientsList />
  		</DashboardLayout>
  	);
  }
  ```

### 9) External APIs and manual services

- **Proxying vs Direct:** For 3rd-party APIs, if you need to hide secret keys or want the strict type-safety of OpenAPI generation, **proxy them** through Next.js API routes (`src/app/api/...`) and let Orval generate the hooks.
- **Manual network services:** However, if proxying feels like overcomplication (e.g., no secrets are involved, or you just want a simple/quick direct fetcher), you can skip the proxy route entirely. Write a direct Axios call and place it in `web/src/services/manual/`. Do not put it in the root of `src/services/` to keep it clean for Orval.
- **Client-side SDKs:** For browser-specific SDK wrappers (e.g., maps, analytics, direct-to-S3 uploads), place them in `web/src/lib/`.

## Database Notes

- Drizzle schema lives in `web/src/db/schema.ts`.
- Apply schema to DB: `pnpm db:push` from `web/`.

### Person vs patient (identity model)

- **`person`**: Global identity keyed by **unique `phoneNumber`**. Created on inbound calls (`source: "call"`) or when a doctor adds a patient (`source: "doctor"`). Holds canonical profile fields the AI can enrich (`firstName`, `lastName`, `dateOfBirth`, `gender`, `address`). Upsert helper: `web/src/lib/person.ts` → `upsertPersonByPhone(phone, source)` — `source` is set only on insert.
- **`patient`**: **Doctor ↔ person** link (`doctorId` + `personId`) plus **per-doctor** fields (`cin`, names, address, etc.) the doctor may customize. Medical files and appointments still reference `patient.id`.
- Phone bookings without a linked patient still store caller name/phone on `appointment` as `newPatientName` / `newPatientPhoneNumber`.

### Other main tables

- `speciality`, `cities`
- `doctor_profile`, `doctor_application`, `doctor_unavailability`
- `patient`, `patient_medical_file`
- `appointment`, `consultation`
- `call`, `call_event` (Twilio call logging from socket)
- Better Auth tables via `auth-schema`, re-exported from schema entry.

## Key API routes (booking & identity)

| Route | Auth | Purpose |
|-------|------|---------|
| `POST /api/persons` | Public | Upsert person by `phoneNumber` (+ optional `source`) |
| `PATCH /api/persons/[id]` | Public | Update person profile (socket AI `update_person_info`) |
| `POST /api/patients` | Doctor session | Create patient; upserts person with `source: "doctor"` |
| `POST /api/appointments/external` | Public | Phone/AI booking; upserts person (`call`), sets `newPatient*` on appointment |
| `POST /api/calls` | Internal secret | Create call row (socket) |
| `GET /api/doctors/best-fit` | Public | Slots for AI `find_available_slots` |
| `GET /api/doctors/availability` | Public | Per-doctor slots for `find_doctor_slots` |

## Environment Notes

- Frontend/web uses env vars like:
  - `NEXT_PUBLIC_APP_URL`
  - `NEXT_PUBLIC_REALTIME_URL`
  - `DATABASE_URL`
  - `INTERNAL_API_SECRET` (must match socket)
  - R2/CDN vars (`R2_*`, `CDN_URL`)
- Realtime/socket uses vars like:
  - `PORT`, `LOG_LEVEL`, `PUBLIC_SOCKET_HOST`
  - `NEXTJS_API_URL` (Next base URL for `nextjsApi`)
  - `INTERNAL_API_SECRET`
  - AI/audio tuning vars (`VAD_THRESHOLD`, `SILENCE_DURATION_MS`, `MAX_OUTPUT_TOKENS`)
  - Twilio (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`)

## File uploads (Cloudflare R2)

- **We do not send file bytes through our own API for storage.** The client requests a **presigned upload URL** from `POST /api/upload/signed-url` (session required), which returns `signedUrl` and the final public **`cdnUrl`** (built from `CDN_URL` + object key; see `web/src/app/api/upload/signed-url/route.ts`).
- **Client helpers** in `web/src/lib/upload.ts`:
  - `uploadToR2(file, folder)` for `File` inputs.
  - `uploadBlobToR2(blob, filename, folder)` wraps blobs as `File` (e.g. canvas output from `react-easy-crop`).
  - Both call `getSignedUploadUrl` in `web/src/services/upload.ts`, **`PUT`** the bytes to `signedUrl`, then return **`cdnUrl`**.
- **Folders** (typed as `UploadFolder`): `profile-pictures`, `doctor-applications`, `medical-files`.
- **Persistence:** after upload, features store only the **public CDN URL string** on the relevant record (e.g. profile picture via `updateProfilePicture(cdnUrl)` after `uploadBlobToR2` in `web/src/components/dashboard/profile/image-cropper.tsx`; doctor application docs use `uploadToR2` similarly).

## Reference Files for Coding Style

Use these as examples before changing related code.

### Frontend references

- `web/src/components/auth/register-form.tsx` (React Hook Form + Zod + Tailwind UI)
- `web/src/components/admin/stats.tsx` (SWR + service usage in client component)
- `web/src/components/admin/applications-table.tsx` (table/data UI conventions)
- `web/src/components/admin/calls/live-calls.tsx` (realtime dashboard UI pattern)
- `web/src/hooks/use-realtime-socket.ts` (custom hook with websocket/reconnect logic)
- `web/src/services/generated/*` (Orval generated SWR hooks and API clients)
- `web/src/services/types.ts` (shared domain/composite typing)
- `web/src/app/api/appointments/route.ts` (API route + Zod + auth helper + Drizzle)
- `web/src/lib/person.ts` (shared person upsert for routes)
- `web/src/lib/api-utils.ts` (auth/role/internal helpers for API routes)
- `web/src/lib/upload.ts` + `web/src/services/upload.ts` (R2 presigned upload + `cdnUrl` return)
- `web/src/components/dashboard/profile/image-cropper.tsx` (crop → blob → `uploadBlobToR2` → save URL)
- `web/src/app/(navbar)/dashboard/(verified)/patients/page.tsx` (dashboard/admin page layout wrapper pattern)

### Backend/realtime references

- `socket/src/server.ts` (Express + websocket + `/incoming-call` + early person/call upsert)
- `socket/src/sessions/twilioSession.ts` (session orchestration, tool handlers, `callerPhone` for booking)
- `socket/src/sessions/systemMessages.ts` (AI prompt + tool definitions)
- `socket/src/api/personsApi.ts`, `socket/src/api/callsApi.ts` (cached idempotent Next API clients)
- `socket/src/types/index.ts` (message contracts and API data types)
- `socket/src/constants/*` (shared static domain data: cities, specialities)

## Voice booking (`socket`)

### Caller phone

- Twilio `From` is passed into the stream (`callerPhone` custom parameter) and stored on `TwilioSession` as `this.callerPhone`.
- On `/incoming-call`, `ensurePersonRow(from)` runs in parallel with `ensureCallRow` (same cached promise pattern as media-stream `start`).
- When `callerPhone` is set, extra instructions are appended in `buildSessionInstructions()` — the assistant must **not ask** the patient about their phone number.

### AI tools (see `systemMessages.ts`)

- `get_specialities`, `get_cities` — static lists in socket constants.
- `find_available_slots`, `find_doctor_slots` — Next doctor/slot APIs.
- `update_person_info` — `PATCH /api/persons/[id]` via `updatePersonRow`; call after collecting name/details.
- `book_appointment` — `POST /api/appointments/external`. Tool args: `doctor_id`, `patient_name`, `illness`, `start`, `end` only. **Phone is not an AI parameter**; `bookAppointment()` sends `this.callerPhone` (digits only) server-side.
- `end_call` — schedules Twilio hangup after closing message.

### Conversation style (prompt)

- **One question per turn** — do not bundle city, time, and symptoms in one sentence.
- Book only after the patient accepts a slot from tool results; never invent doctor IDs or times.

## Practical AI Instructions

- **Git usage rule**: The AI must **never** run `git commit` or any git commands that modify repository state or history (`git commit`, `git add`, `git checkout`, `git push`, `git reset`, `git rebase`, `git stash`, etc.). The AI may only use git for read-only operations (e.g., `git diff`, `git status`, `git log`, `git show`, `git branch`).
- Use **pnpm** for package and script commands (see [Package management](#package-management)).
- For schema changes in dev, prefer `pnpm db:push` in `web/`.
- For R2 uploads, use `uploadToR2` / `uploadBlobToR2` and persist the returned **`cdnUrl`** (see [File uploads (Cloudflare R2)](#file-uploads-cloudflare-r2)).
- When creating pages in `dashboard` or `admin`: keep `page.tsx` thin and wrap content in layout primitives (e.g. `<DashboardLayout title="...">` or `<AdminLayout title="...">`) as seen in `web/src/app/(navbar)/dashboard/(verified)/patients/page.tsx`.
- When adding or changing frontend data access:
  - DO NOT write manual fetchers in the root of `web/src/services/`. All internal data fetching MUST use Orval-generated hooks.
  - For external APIs, proxy via Next.js if you need to hide secrets or want Orval to generate the hook.
  - If proxying is overkill, or you just want a simple direct fetcher, place it in `web/src/services/manual/`.
  - consume via SWR/hooks/components
- When adding API behavior:
  - implement in `web/src/app/api/.../route.ts`
  - validate with Zod
  - enforce session/role/internal with `api-utils`
  - reuse `upsertPersonByPhone` when linking patients or phone bookings to `person`
  - keep error response shape consistent (`web/src/lib/errors.ts`)
- When adding realtime events:
  - update message types in `socket/src/types/index.ts`
  - broadcast from `sessions/twilioSession.ts`
  - handle in `web/src/hooks/use-realtime-socket.ts`
- When adding socket → Next calls, follow `api/callsApi.ts` / `api/personsApi.ts` patterns (cached promises, structured logging).
- Prefer consistency with existing files over introducing new patterns.
