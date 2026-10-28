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
   - Build it like `HealthFunction`: `CodeUri: ./`, `Metadata: BuildMethod: esbuild` with its own entry point.
   - If it uses `getRuntime()`, add `External: ['@aws-sdk/*']` to `BuildProperties` (the SDK ships in the Lambda runtime), and let it read exactly the four secrets, nothing else. Not `SSMParameterReadPolicy`: that one also grants `ssm:DescribeParameters` on `*`, and every secret of the stage.
     ```yaml
     Policies:
       - Statement:
           - Effect: Allow
             Action: ssm:GetParameters
             Resource:
               - !Sub arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter/fieldflow/${Stage}/tadabase/app-id
               - !Sub arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter/fieldflow/${Stage}/tadabase/app-key
               - !Sub arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter/fieldflow/${Stage}/tadabase/app-secret
               - !Sub arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter/fieldflow/${Stage}/webhook-secret
     ```
     Every value needs `!Sub`: without it, `${Stage}` stays literal and every read is denied at runtime. The `aws/ssm` key needs no `kms:Decrypt` grant; a customer-managed key would.
   - Its log group goes in `tests/infra/stateful-resources.json` (ask the user to approve that edit).
   - Use SAM policy templates scoped to the exact resources it uses, never `*`.
   - Secrets come from SSM parameters, never literal values.
   - Any new bucket or table gets `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain`.
5. **`tests/functions/<name>.test.js`:** cover the cases listed in the test-writer agent: happy path, 400, 401, upstream error, duplicate delivery.
6. **`.env.example`:** add any new config key, with a comment.

## Then
Run the `verify` skill, then the `review-diff` skill. `infra-reviewer` runs there because `template.yaml` changed.
