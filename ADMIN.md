# Admin dashboard

The admin area lives at `/admin` in `frontend/` and talks to `/api/admin/*` in `api/`.

## Creating the first admin

```bash
cd api
npm run seed:admin -- admin@example.com           # prompts for a password; blank = generated
npm run seed:admin -- admin@example.com "S3cret!"  # non-interactive
ADMIN_SEED_EMAIL=... ADMIN_SEED_PASSWORD=... npm run seed:admin   # via environment
```

`ADMIN_SEED_NAME` sets the display name (default "Administrator"). Re-running is safe: an existing account
is promoted to ADMIN and restored if it was suspended. Its password only changes when you pass one, and
then its other sessions are signed out. For a new account with no password, a generated password is
printed once. After signing in, the user menu links to `/admin`.

## Routes
| Route | Purpose |
| --- | --- |
| `/admin` | Overview: stat cards, 30-day trend chart, top summaries, recent admin activity |
| `/admin/users` | Search/filter users, change roles, reset passwords, revoke sessions, suspend/restore |
| `/admin/content` | Summaries by status (published / drafts / archived), archive & restore |
| `/admin/content/new` | Create a summary (writes `lib/summaries.ts` + MDX) |
| `/admin/content/[slug]` | Edit metadata, English/Hindi MDX, publish state |
| `/admin/content/[slug]/preview` | Saved metadata preview + MDX source |
| `/admin/comments` | Moderate comments (soft delete / restore) |

The admin has its own root layout (`app/(admin)/layout.tsx`), so it renders without the public header,
footer or locale switch. It is English-only and follows the normal light/dark theme toggle.

## How content editing works

Summaries are **not** in the database. Metadata lives in `frontend/lib/summaries.ts` and bodies in
`frontend/content/summaries/**/[slug].mdx`. The API writes those files directly, so it must run on the
same machine as the frontend checkout:

- `FRONTEND_DIR` (in `api/.env`): path to the Next.js app, relative to the `api/` package (default `../frontend`).
- `ADMIN_INTERNAL_SECRET`: shared secret; set the **same value** in `api/.env` and `frontend/.env.local`.

On every save the API:

1. Updates the metadata entry in `summaries.ts` (this file is parsed and re-serialized, not regenerated).
2. Writes the MDX body files (creating directories as needed).
3. Copies the previous version to `frontend/.admin-backups/<timestamp>/…`.
4. Calls `POST /api/admin/revalidate` on the frontend with the affected paths.

If step 4 fails (frontend down, deploy in progress), the save still succeeds and the response says the site
was not revalidated; the change appears after the next deploy or revalidation.

## Status and soft deletes

- `SummaryDocument` (MongoDB) stores only the editorial status: `DRAFT`, `PUBLISHED`, `ARCHIVED`.
  Summaries without a row are treated as `PUBLISHED`. Archiving hides them from the public list and pages
  without touching the files; restoring is a status change back to `PUBLISHED`.
- `User.deletedAt` suspends an account: sign-in and refresh are rejected and existing sessions are revoked.
- `Comment.deletedAt` hides a comment from the public comment lists and counts.
- Every admin mutation is appended to `AdminAction`, shown on the Overview page.

## Deployment notes

- The API and frontend must share a filesystem for content editing. If the frontend is on Vercel and the
  API writes to a repo checkout elsewhere, the public site will only see saved content after that checkout
  is built and deployed.
- Set `ADMIN_INTERNAL_SECRET` in production; without it the API writes files but skips revalidation.
- `prisma db push` has already been applied to add the `SummaryDocument` and `AdminAction` collections and
  the soft-delete indexes.
