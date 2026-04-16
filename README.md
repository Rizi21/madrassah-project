# Madrassah Web MVP

Local-first browser MVP for a madrassah management system with separate teacher and parent interfaces.
The current tenant config is `Makki Masjid Madrassah`.

## What is included

- Role-based login for `teacher` and `parent`
- Teacher dashboard for:
  - attendance tracking
  - Qur'an lesson progress notes
  - sabak, sabki, manzil, and homework tracking
  - fee status updates
  - assigned class/group visibility
  - basic strong-point and weak-point summaries
- Parent dashboard for:
  - attendance visibility
  - recent progress notes
  - fee visibility
- SQLite-backed demo data with seeded users and students
- Per-masjid JSON config for display name, role labels, contact numbers, logo path, fee defaults, and seed users
- Admin class/group management for assigning teachers and grouping students
- Multi-guardian linking so one parent can see multiple children and one child can have multiple guardians

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`

## Demo users

- Admin: `admin@makki-masjid.test` / `Password123!`
- Ustadh: `soban@makki-masjid.test` / `Password123!`
- Guardian: `parent@makki-masjid.test` / `Password123!`

## Signup and approval

- Masjid code: `MAKKI-MCR`
- Admin setup code: `MAKKI-ADMIN-SETUP`

Normal users sign up with the masjid code and start as `pending`. They cannot log in until a masjid admin approves them and assigns `teacher`, `parent`, or `admin`.

Admins can sign up with the admin setup code. For production, this should become a one-time invite or controlled onboarding flow.

Password reset is available from the login page. In this local MVP, the reset link is shown on screen instead of being emailed.

## Masjid config

The default config file is:

```bash
config/tenants/makki-masjid.json
```

To add another masjid, create another JSON file under `config/tenants/` with the same shape and run the app with:

```bash
TENANT_CONFIG_PATH=config/tenants/your-masjid.json npm run dev
```

Logos are configured with `logoPath`. Put the logo under `public/tenants/<tenant-id>/`, then reference it from the JSON file. For example:

```json
{
  "tenantId": "makki-masjid",
  "logoPath": "/public/tenants/makki-masjid/logo.svg"
}
```

The app currently supports SVG, PNG, JPEG, or WEBP logos as normal static assets.

## Production direction

This MVP is intentionally a single deployable web application. For production, the next pragmatic step is:

1. move from SQLite to managed PostgreSQL
2. replace local cookie/session handling with a stronger auth stack
3. add mosque-level multi-tenancy and admin roles
4. add audit logs, backups, monitoring, and encryption controls
5. introduce payment integration only after manual fee workflows are stable
