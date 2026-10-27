---
name: new-lambda
description: Add a new Lambda function the project's way - handler in functions/<name>/, platform adapter injection, input validation, webhook secret check, template.yaml entry with least-privilege policies, and tests. Use whenever a new endpoint or function is needed.
argument-hint: "[function-name] [what it does]"
---

# New Lambda function

Function: $ARGUMENTS

Look at an existing function in `functions/` first, if there is one, and match it.

## Files
1. **`functions/<name>/handler.js`**
   - Export `createHandler({ platform, config })`, which returns the async `handler(event)`.
   - Also export `handler`, wired to the real adapter from `lib/platform` and config from the environment.
   - That way tests inject the memory adapter, and production gets the Tadabase one.
2. **Order inside the handler:**
   - Verify the webhook secret, constant-time → 401.
   - Parse and validate the body → 400.
   - Do the work through `platform`.
   - Return JSON through the shared response helpers.
3. **Idempotency:** if the function creates something (a PDF, a CRM contact, an email), first check whether it already exists for this record and event, so a retried webhook doesn't do it twice.
4. **`template.yaml`:**
   - Add the function with its own `Timeout` and `MemorySize`, and the API event.
   - Use SAM policy templates scoped to the exact resources it uses, never `*`.
   - Secrets come from SSM parameters, never literal values.
   - Any new bucket or table gets `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain`.
5. **`tests/functions/<name>.test.js`:** cover the cases listed in the test-writer agent: happy path, 400, 401, upstream error, duplicate delivery.
6. **`.env.example`:** add any new config key, with a comment.

## Then
Run the `verify` skill, then the `review-diff` skill. `infra-reviewer` runs there because `template.yaml` changed.
