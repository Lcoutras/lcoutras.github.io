# Family Recipe Box (website edition)

A shared family recipe book: recipes with photos, categories, a weekly meal planner, a grocery list and a cooking mode.
Served from this repository at `https://lcoutras.github.io/recipes/`.

## How access works

There are no accounts. Everyone opens the **family link**, which ends in `?k=<family key>`.
The first visit saves the key on that device and asks for a first name (shown as "Added by …").
Anyone without the key sees a "private to our family" screen.

The data lives in a Supabase project. Its tables have row level security on and no policies, so the
publishable key in `config.js` cannot read them. The site only calls the `rb_*` functions in
`supabase/schema.sql`, and each one checks the family key against a stored hash first.

## Setting up the database

1. Create a Supabase project.
2. Run `supabase/schema.sql` in the SQL editor.
3. Store the family key's hash:
   `insert into rb_access (key_hash) values (encode(sha256(convert_to('THE-FAMILY-KEY','UTF8')),'hex'));`
4. Put the project URL and publishable key in `config.js`.

To change the family key (if the link gets passed around), run
`update rb_access set key_hash = encode(sha256(convert_to('NEW-KEY','UTF8')),'hex');` and send everyone the new link.

## Keeping the database awake

Supabase pauses free projects after 7 days without activity. `.github/workflows/keep-recipe-box-awake.yml`
calls `rb_ping()` once a day (it reads no data). If the database doesn't answer, the run fails and GitHub
emails the repository owner with a link to unpause it. It can also be run by hand from the **Actions** tab.
GitHub stops scheduled jobs in repositories with no changes for 60 days; re-enabling it is one tap in **Actions**.

## Files

| File | Purpose |
|---|---|
| `index.html` | The app (same app as the Claude version) |
| `shim.js` | Connects the app to Supabase: storage, live updates by polling, photos, names |
| `config.js` | Supabase project URL and publishable key |
| `supabase/schema.sql` | Tables and the key-checked functions |

Claude features (reading posts, filling in missing ingredients) are off in this edition; recipes are added by hand.
