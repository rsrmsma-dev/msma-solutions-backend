# Self-registration: what the screens need

The Register form on the sign-in page now saves to the database. Nothing about its look changed; it
calls `registerEmployee` (`src/lib/api.ts`) as before.

## How it works

1. HR adds the employee first (People › Add employee), with their email and mobile number.
2. The person opens **Register your account** and fills in the form.
3. The server checks that the **full name, email and mobile number** all match that employee. The
   name may skip a second given name or the middle name, or use initials; email and mobile must be
   exact. Position, office and cluster on the form aren't part of the match.
4. When they match, the person's **Employee sign-in is created** right away:
   - username: the part of their email before the @ (e.g. `jjm.msma`; a number is added if it's taken)
   - password: a long random one nobody knows, so they **can't sign in yet**
   The form shows "You're registered" with their employee ID as the reference.
5. **HR gives them a temporary password**: on the Users page, Reset password on that person. The new
   temporary password is shown once; HR hands it over with the username.
6. They sign in and change it in Settings › Security.

Who registered is in the audit trail (Sign-in › "Registered").

## Changes needed on the website

- **Show the server's message when registering fails.** Today a refused registration shows nothing:
  the button just stops spinning. `mutation.error.message` holds a ready-to-show message, for example
  "We couldn't match those details to an employee record…" or "You're already registered (username
  jjm.msma). Ask HR for your temporary password…". Put it under the Register button.
- **Email and mobile are now required.** They're how the server finds the person's record. The
  labels say "(optional)"; please drop that, and ideally make the form require them too.
- **Success text:** it says "HR will review your details and set up your system access". It could
  also say "Ask HR for your temporary password. Your username is the part of your email before the @."
- **HR needs the Users page** to hand out temporary passwords (Reset password). Today only the Super
  Admin sees it: see `server/ROLES.md` for the access-table change.
- The "Continue with Google" button still shows two made-up accounts; real Google sign-in needs a
  Google Cloud OAuth client (free) before it can work.
