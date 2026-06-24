# House Accounts v23 - Repeat Pattern Signal Fix

This release fixes repeat/pattern signal detection for richer order-history uploads.

Changes:
- Adds column mapping support for Category, Order Amount, Quantity, and Primary Contact.
- Uses explicit category columns when available instead of relying only on project names.
- Adds repeat-pattern detection across categories, dates, and years.
- Generates Repeat / Pattern Signals when an account has recurring seasonal or repeated category purchases.
- Balances the Daily Reasons feed so follow-up signals remain highest priority but do not crowd out repeat/pattern signals when available.
