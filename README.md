# SendNewsletters 0.1.0

A desktop tool to send form requests to a mailing list — by email or paper mail depending on what's on file — and track who has responded and who hasn't.

## What it does

1. Import a mailing list from a CSV or spreadsheet file. Any column not explicitly mapped is kept and can still be used to select recipients. Map a column to **ID** and re-importing later updates any contact whose ID matches, in place, instead of creating a duplicate — so a refreshed list keeps its mailing/tracking history.
2. Build a mailing by filtering the list on any field (e.g. "Committee = Finance").
3. Contacts with an email address get the email version; everyone else gets the paper version.
4. Email and paper mailings use separate templates.
5. The email contains a personalized link to a Gravity Forms web form (on your own website) plus a blank fillable PDF attachment (stamped with the recipient's reference code in the footer).
6. Responses are tracked no matter how they come back: submitted online (auto-detected by the link's token or the member ID typed into the form), emailed back as a completed PDF, or mailed back on paper (both recorded manually with the returned PDF or scan attached). Files can also be attached to a response afterwards — say, a PDF emailed in by someone who had already submitted online.
7. The tracking table exports to CSV or Excel.
8. The tracking page shows at a glance who has and hasn't replied.

## Requirements

- Windows (or macOS/Linux — Electron is cross-platform, but this has been built/tested against Windows).
- Node.js 18+ and npm.
- A way to send through SMTP: either an email account (e.g. a Gmail account with an [app password](https://myaccount.google.com/apppasswords)), or an unauthenticated relay your IT team sets up (e.g. an IP-allowlisted connector on a static IP) — for the latter, leave **SMTP username/password blank in Settings** and fill in **From email**, since there's no username for it to default to.
- A Gravity Forms form on a WordPress site you control, for recipients to fill out online (see setup below). Paper and emailed-PDF responses don't need this.

## Getting started

```
npm install
npm start
```

All data (contacts, templates, generated PDFs/letters, and tracking records) is stored locally under the app's data folder — see **Settings → Data location** inside the app.

## One-time Gravity Forms setup (for the online response channel)

SendNewsletters doesn't host the web form itself — it uses a form already on your WordPress site, so the emailed link works immediately for real recipients without deploying anything. To wire it up:

1. **Add a hidden token field.** In the Gravity Forms form editor, add a hidden field. In its settings, turn on **Allow field to be populated dynamically** and set a parameter name (SendNewsletters defaults to `rtoken`). Note the field's **Field ID** (shown in the field settings) — you'll need it below.
2. **Enable the REST API.** Under *Gravity Forms → Settings → REST API*, enable the API and turn on **Basic Authentication** (your site must be HTTPS). Create a new API key with at least read access, and note the **Consumer Key** and **Consumer Secret**.
3. **Note the form ID and page URL.** The form's numeric ID is visible in the Forms list. Note the public page URL where the form is embedded.
4. In SendNewsletters, go to **Gravity Forms**, fill in the site URL and consumer key/secret, click **Test connection** to confirm and pick the form, then fill in the page URL, token parameter name, and the hidden field's ID.
5. *(Optional)* If the form asks for a member ID, also fill in that field's ID as **Member ID field ID**. Submissions without a token (e.g. from a plain link to the form) are then matched against the contacts' ID column — ignoring case and spacing, and treating look-alike characters such as O/0 and I/L/1 as the same when that still points to exactly one member.

SendNewsletters never needs an inbound connection to your computer — it only reaches out to the Gravity Forms REST API, on a 5-minute timer or when you click **Sync Gravity Forms now** on the Tracking page, to pull in new submissions and match them to recipients. Only submissions made after a mailing was created are considered. Anything that can't be matched with confidence is listed under **Online responses to match** on the Tracking page, with suggested members, to match by hand or dismiss.

## Typical workflow

1. **Import List** — upload your CSV/spreadsheet, map columns, import.
2. **Templates** — create one email template and one paper template. Use `{{externalId}}`, `{{name}}`, `{{email}}`, `{{addressLine1}}`, `{{form_link}}`, or `{{extra.ColumnName}}` for any other imported column. Attach a fillable PDF to the email template.
3. **Gravity Forms** — register your form connection (one-time, see above).
4. **Settings** — enter your SMTP details and send a test. **Appearance** there switches between light and dark, or matches Windows.
5. **New Mailing** — filter your contacts, pick templates and the Gravity Forms connection, create the mailing.
6. **Mailings** — review the email/paper split, then **Send**. Emails go out immediately; paper mailings generate a print-ready letter PDF per recipient (open it from the Tracking page) for you to print and mail. Any email that fails (a bad address, say) shows as **Send failed** on the Tracking page with the error; use **Fix & resend…** to correct the address, or clear it to send a paper letter instead. To email the form again to everyone who hasn't responded (it went to spam, say, or the first copy needed correcting), use **Resend…** on the sent mailing; it uses the email template and PDF as they are now, with each person's same link and reference code.
7. **Tracking** — see who has and hasn't responded; **Resend** on an emailed row sends that one person the form again. Online responses show up automatically after a sync. Use **Mark received…** to record an emailed-back PDF or a mailed-back paper form, with the PDF or scan attached. For someone who has already responded (e.g. they submitted online and then emailed a PDF too), use **Attach file…** on their row; open or remove attached files by clicking the row. Once a response has been entered into the office's records software, tick its **Entered** box (the date is recorded); filter Status to **Responded — not yet entered** to see what's still waiting. Export to CSV/Excel any time.
8. **Responses** — work through returned forms one at a time while entering them into the records software: the member ID and each answer (labeled with the form's own questions) have **Copy** buttons, and **Mark entered & next** ticks the response off and moves to the next one. Any attached PDFs or scans are listed above the answers, and **Attach file…** adds one there too. Every online submission is kept; if someone submits again after their response was entered, it goes back into the "not yet entered" queue.

## Project layout

- `main.js` / `preload.js` — Electron main process and the IPC bridge exposed to the UI.
- `db/store.js` — local JSON-file data store (contacts, templates, mailings, tracking).
- `lib/` — CSV/spreadsheet import, template merging, PDF stamping, paper letter generation, SMTP sending, and the Gravity Forms API client.
- `renderer/` — the UI (plain HTML/CSS/JS, no build step).
