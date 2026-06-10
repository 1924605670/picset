# P0 SQLite Storage

This phase adds the storage foundation for a future multi-user PicSet system while keeping the current single-user UI compatible.

## Tables

- `users`: local users with role, status, and optional password hash.
- `sessions`: future HTTP session storage using hashed tokens.
- `project_members`: project-level user roles.
- `audit_logs`: append-only operation log for record writes and deletes.
- `generation_tasks`: future persistent generation queue/task state.
- `email_verifications`: short-lived email verification codes for registration and login.
- `records`: existing JSON store, extended with `owner_id` and `deleted_at`.

## Bootstrap

On server startup:

1. SQLite creates any missing P0 tables.
2. Existing `records` tables are upgraded with `owner_id` and `deleted_at`.
3. A default owner user is created with id `user_system_admin`.
4. Existing records are migrated to `user_system_admin` unless they already carry `ownerId`.
5. Existing projects receive an owner membership row in `project_members`.

Optional admin seed environment variables:

```env
PICSET_ADMIN_USERNAME=admin
PICSET_ADMIN_EMAIL=admin@picset.local
PICSET_ADMIN_DISPLAY_NAME=系统管理员
PICSET_ADMIN_PASSWORD=
```

If `PICSET_ADMIN_PASSWORD` is empty, the default owner account is created with `setup_required` status. The first real email-verified registration becomes an `owner` and receives owner membership on existing projects, so existing migrated data remains accessible after auth is enabled.

## Email Auth

Registration and login use Resend email verification codes.

Required production environment variables:

```env
RESEND_API_KEY=...
RESEND_FROM=PicSet <noreply@example.com>
PICSET_AUTH_SECRET=replace-with-a-long-random-secret
```

Optional environment variables:

```env
PICSET_APP_NAME=PicSet
PICSET_AUTH_REQUIRED=1
PICSET_COOKIE_SECURE=1
PICSET_BASE_PATH=/picset
PICSET_DEV_AUTH_CODE=0
```

`PICSET_DEV_AUTH_CODE=1` returns the verification code in the API response for local automated tests. Do not enable it in production.

Auth API:

- `GET /api/auth/me`: current session and auth configuration status.
- `POST /api/auth/register/send-code`: send registration code.
- `POST /api/auth/register/verify`: verify registration code, create user, create session.
- `POST /api/auth/login/send-code`: send passwordless login code.
- `POST /api/auth/login/verify`: verify login code, create session.
- `POST /api/auth/logout`: revoke session and clear cookie.

## Compatibility

The frontend can keep using the existing `/api/data/*` endpoints. Server writes now attach:

- `ownerId`
- `projectId`
- `createdAt`
- `updatedAt`

Deletes are soft deletes through `deleted_at`, so list/bootstrap reads only return active records.

## Management API

`GET /api/admin/storage/overview` returns counts for:

- SQLite file size
- users by role/status
- projects and project members
- active/deleted records by store
- generation tasks by status
- audit log totals

This endpoint is a storage diagnostic surface and is protected by owner/admin auth.
