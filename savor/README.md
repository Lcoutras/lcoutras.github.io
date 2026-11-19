# Savor (accounts edition)

- `index.html` is the page you send to friends and family.
- `app/` is the app. People sign in with email, Google or Apple, and each recipe book belongs to the people in it.
- `supabase/schema.sql` is the database setup (already applied). Every table is locked; the page only calls the `sv_*` functions, which check who is asking.
- The Claude function lives in `../recipes/supabase/functions/rb-claude/index.ts`. It accepts a signed-in person's token and charges a daily allowance (research 5, draft 1, photos 1; 60 per day by default, changeable per person in `sv_profiles.daily_units`).

## One-time settings in the Supabase dashboard (Authentication)
1. URL Configuration: Site URL `https://lcoutras.github.io/savor/app/`, and add the same address under Redirect URLs.
2. Providers, Email: decide whether "Confirm email" is on. Supabase's built-in email sender is limited to a few messages per hour, so turn confirmation off while testing with a group.
3. Providers, Google and Apple: create the credentials with each company and paste them in (the Redirect/Callback URL to give them is shown on that page).
