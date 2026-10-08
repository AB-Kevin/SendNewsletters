# SendNewsletters 0.1.0

A desktop tool for keeping the mailing list for the office's newsletters and magazines (MAAP Newsletter and Our Health to start) and sending each issue out: emailed as a PDF attachment to everyone who gets it by email, and an address list with copy counts for every address and organization that gets it by mail.

## Who gets what

There are three kinds of recipient, and each newsletter is set separately for each:

- **People** — name, email address, and the organization (church) they belong to, if any. A person can get a newsletter **by email**.
- **Households** — an address, shared by everyone who lives there. A household can get a newsletter **by mail**, with a number of **copies** — one bundle for the address, however many people live there.
- **Organizations** — a church's own address (or its rep's), an **Attention** line for who batches are addressed to, and an optional email. An organization can get a newsletter as a **batch by mail** for its members, with a number of copies, or by email.

A person whose organization gets a newsletter as a batch is **covered** for it: imports don't sign them up for their own copy, and their cells are hatched on the Mailing List. They can still have their own copy — just tick it.

So John can get MAAP Newsletter by email and Our Health at his address by mail, while his church gets a batch of 15 MAAP copies for everyone else.

## What it does

1. **Mailing List** — two editable spreadsheets, **People** and **Organizations**, with an Email / Mail / Copies column group per newsletter. Edits save as you go. **Newsletters…** adds, renames or removes a newsletter or magazine.
2. **Import** — bring in a CSV or Excel file, or new signups from the website's Gravity Forms signup form. You say which newsletters the list is for; columns are matched up automatically where the headings are recognizable; people already on the list are updated rather than added twice; and new people at an address already on the list join that household.
3. **Duplicates** — the list comes from several places, so the app flags people who might be the same person, separate households that look like the same address, and organizations that might be the same church, to merge or keep apart.
4. **Mailings** — one mailing is one issue of one newsletter, to everyone set up to get it.
5. **Delivery** — per mailing, who was emailed, whose email failed (fix the address and resend), and which addresses and batches have been mailed.

## Requirements

- Windows (or macOS/Linux — Electron is cross-platform, but this has been built/tested against Windows).
- Node.js 18+ and npm.
- A way to send through SMTP: either an email account (e.g. a Gmail account with an [app password](https://myaccount.google.com/apppasswords)), or an unauthenticated relay your IT team sets up (e.g. an IP-allowlisted connector on a static IP) — for the latter, leave **SMTP username/password blank in Settings** and fill in **From email**, since there's no username for it to default to.
- For signup imports: the Gravity Forms REST API turned on (WordPress → Forms → Settings → REST API) with a key that can read entries, on a site using https.

## Getting started

```
npm install
npm start
```

All data (the mailing list, newsletters, templates and their PDFs, and the record of every mailing) is kept in one data folder — by default inside this computer's app folder. See **Data location** below to keep it somewhere else.

## Typical workflow

1. **Settings** — enter your SMTP details and a test address, and **Test connection**. Under **Signup form**, enter the website address and the Gravity Forms consumer key and secret, **Connect and list forms**, pick the signup form, and save. **Appearance** switches between light and dark, or matches Windows.
2. **Mailing List → Import…** — choose a file, or **Get new signups** from the signup form (only signups since the last import, unless you tick the box). Say whether **each row is a person or an organization**, tick which newsletters the list is for, check the column matches, look over **What will happen**, and import.
   - Import a church reps list as **organizations**: each row's church gets the ticked newsletter as a batch, addressed to the person named in the row.
   - Import each newsletter's own list with just that newsletter ticked — someone on both lists ends up getting both.
3. **Duplicates** — the count beside it in the menu is how many are waiting. For each, pick which values to keep and **Merge into one**, or **Not the same**; untick **Same one** on any record that doesn't belong in a group. For addresses that look like one household, **Make one household** or **Keep separate**. Either way, it isn't suggested again.
4. **Mailing List** — fix anything flagged in red (checked for email with no usable address, checked for mail with an incomplete address or 0 copies). The Show menu narrows to one newsletter — getting it at all, by email, by mail, or through their organization — and hides the other newsletters' columns while it does. It also finds **Households of 2 or more**, people getting nothing, and people with their **own copy of something their organization also gets**.
5. **Templates** — write the email (rich text, with `{{name}}`, `{{orgName}}`, `{{email}}`, `{{addressLine1}}`, `{{city}}`, `{{state}}`, `{{zip}}`, `{{copies}}`) and attach the issue's PDF. It's attached to every email as-is, under its own file name. Sent to an organization, `{{name}}` is its Attention line.
6. **New Mailing** — pick the newsletter, choose email, mail, or both, optionally narrow it to part of the list (e.g. State is one of PA, OH), pick the template, and create it. The counts show people by email, household addresses, organization batches, copies to mail, and anyone left out and why.
7. **Mailings** — **Test** sends one copy to your test address. **Send emails** sends the rest. **Mailing addresses…** saves one row per address — a household named for everyone who lives there ("John & Mary Stoltzfus"), or an organization's batch to whoever its Attention line names — with its number of copies, as Excel or CSV for labels or a mail merge. **Resend…** emails everyone again with the template and PDF as they are now.
8. **Delivery** — any email that failed shows as **Send failed** with the server's error; **Fix & resend…** saves a corrected address and sends, or clear the address to mail a copy to their address instead. Once the printed copies go out, **Mark mailed** (or mark every shown address at once). The number of copies is recorded when an address is marked mailed, so later edits to the list don't rewrite what went out.

## The Mailing List spreadsheets

- Click a cell to select it, then type to replace it, or double-click (or Enter/F2) to edit what's there. Enter moves down, Tab moves right, Esc cancels. Ctrl+Z undoes edits, pastes and bulk changes.
- On **People**, shaded, merged cells — a newsletter's Mail and Copies, and the address — belong to the household: changing one changes it for everyone who lives there. Each newsletter's Email box and the email address are each person's own. Hatched cells mean their organization gets that newsletter for them.
- On **Organizations**, click the arrow by a **Members** count to list that organization's members under it (**Show all members** lists everyone's). Their rows work as on People — tick or untick their own Email for each newsletter, or their household's Mail and Copies — and ticking members on the left lets you change them in bulk or **Remove from organization**. Searching a person's name there finds their organization, with them listed under it.
- Type in a person's **Organization** to link them to it — suggestions come up as you type, and a name that isn't on the list yet starts a new organization.
- Copy a block of cells in Excel and paste it onto a selected cell to fill many cells at once.
- Click a column heading to sort; the search box matches any column. A household is always shown together.
- Tick rows on the left (Shift-click for a range) to turn a newsletter's Email or Mail on or off, set its copies, set their organization, **Make one household**, **Separate** (give each their own copy of the address), or delete them.
- **Export…** saves the rows shown, in a layout that imports straight back in — people one per row with their household's address and mailed newsletters, organizations with their batches.

## How imports match

A row updates someone already on the list when the name matches **and** so does either the email address or the street address (ZIP or city). Formatting differences don't count: "123 Main St" and "123 Main Street", or "Smith, John" and "John Smith", are the same. Organizations match by name, ignoring "The" and "Church" ("The Maple Grove Mennonite Church" is "Maple Grove Mennonite").

- Middle names have to agree but can be missing: "John Stoltzfus" matches "John A Stoltzfus", but "John A" and "John S" Stoltzfus at the same farm stay two people. A row that could be either of two people already on the list isn't imported; the import preview names those rows.
- Anything less certain (a nickname, a different name at the same email) comes in as a new contact and is flagged on the Duplicates page instead of being merged on a guess.
- A blank cell never erases what's already there.
- **Ticked newsletters:** everyone in the file gets them — by the file's Mail/Email columns if it has them, otherwise by **How they get it** (by email if they have an address, otherwise by mail; mail only; email only; or both) — unless their organization already gets that newsletter as a batch. Someone who already gets a newsletter keeps how they get it unless the file has a column for it.
- Mail/Email/Copies columns can be general (for the ticked newsletters) or one newsletter's own ("Our Health: Mail"); yes/no columns can hold anything yes/no-ish: Yes/No, X or blank, TRUE/FALSE, 1/0.
- People at the same street, Address 2 and ZIP share a household. A new person joining one turns a newsletter's Mail on if their row says so, and can raise the household's copies but never lower them. Someone already on the list whose row has a different street has moved: they move out, and the rest of their household stays.
- In person mode, a row with an organization but no person's name is the organization itself.

## How duplicates are found

Email addresses and street addresses count most, since names often don't line up across lists. Two people are flagged when they have:

- **the same email address** — each person is meant to have their own, so a shared one is worth a look even with different names;
- **the same street address and a similar name** — nicknames (Bob/Robert, Jake/Jacob, Lizzie/Elizabeth…), initials, and a one-letter slip in the last name count as similar; different names at one address are a household, not a duplicate;
- **the same name where one fills in what the other is missing** — typically a signup (name and email) for someone already on the list by mail. A name shared by more than three such people (there are a lot of John Stoltzfuses) is too common to flag this way.

Separate households are suggested as one when the street and ZIP match, unless both have an Address 2 and they differ (two apartments). Organizations are flagged when they have the same street address, or one name contains the other ("Maple Grove" / "Maple Grove Mennonite").

## Data location

**Settings → Data location → Change…** moves the list to any folder — on OneDrive, say, to back it up or to share one list between computers:

- If the folder picked already has a SendNewsletters list (another computer's, say), you're asked whether to use that list. If not, you're asked whether to copy this computer's list there or start an empty one. Picking a folder that already has other files in it puts the list in a **SendNewsletters Data** folder inside it.
- The old folder is never changed or deleted, so it's there as a backup. **Use this computer's own folder** switches back.
- To share, pick the same folder on each computer — see **Sharing between computers** below.
- Each computer keeps its own email (SMTP) settings, signup-form connection and appearance, outside the data folder: the passwords are encrypted with that Windows account's key, which another computer can't read. When the signup form was last imported is part of the list, so two computers don't import the same signups twice.
- If the folder can't be found when the app starts — OneDrive not signed in, a network drive not connected — it asks whether to try again, choose another folder, or use this computer's own, rather than starting with an empty list.

## Sharing between computers

When several computers use one data folder, one of them is the **host** and the rest are **editors**. Everyone can edit at the same time; only the host's app writes the list itself, so OneDrive never has two versions of the same file to choose between.

- **Editors** keep their changes in their own file in the folder's `people` folder. Their screen shows them straight away, and the host's app saves them to the shared list as soon as their file syncs to it. Two people changing different cells of the same person at once both keep their change; if both change the same cell, the one made later wins.
- **Everyone sees everyone's changes** without doing anything: an open Mailing List, Duplicates, Mailings, Delivery or Templates page refreshes in place (after you finish typing in a cell). On the host, a note says whose changes it just saved.
- **Only the host sends email** — Send emails, Resend and Fix & resend are off on the other computers, which say why. A test email works from any computer. Anyone can create mailings, edit templates and mark copies mailed.
- **If the host's app is closed**, a banner on each editor says so, and their changes wait on that computer — nobody else sees them yet. They're saved as soon as the host's app opens again. Leave the host's app open while others are working.
- **Settings → Sharing** shows your name as others see it, who else is using the folder, and whether this computer is the host. The first computer to use a folder is its host; a computer joining a folder while its host is open becomes an editor. To hand the job over, tick **This computer is the host** on the new one and untick it on the old one.
- If two computers are both set as host, the one that's been host longer does the job and the other waits (and says so) until that one's app closes. A host's app that closed without warning (a crash, a power cut) still counts as open for about five minutes.
- The computers' clocks should be roughly right: when two changes clash, the later one wins by the time it was made.

## Project layout

- `main.js` / `preload.js` — Electron main process and the IPC bridge exposed to the UI.
- `db/store.js` — JSON-file data store (people, households, organizations, newsletters, templates, mailings, mailing recipients) in the data folder, plus this computer's own settings.
- `lib/` — spreadsheet import (`listImport.js`), name/address comparison (`matching.js`), the duplicate checker (`duplicates.js`), the Gravity Forms client (`gravityForms.js`), the delivery rules shared with the UI (`contactRules.js`), sharing a data folder between computers (`team.js`), recipient filters, template merging, and SMTP sending.
- `renderer/` — the UI (plain HTML/CSS/JS, no build step); `grid.js` is the editable spreadsheet both Mailing List tabs use.
