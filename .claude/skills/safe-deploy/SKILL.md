---
name: safe-deploy
description: Deploy the SAM stack to AWS safely - verify, build, create a changeset without executing it, have infra-reviewer check it for deleted or replaced data, and execute only after the user approves. Use only when the user asks to deploy.
disable-model-invocation: true
argument-hint: "[stage, default dev]"
---

# Safe deploy

Stage: $ARGUMENTS. Default `dev`. `prod` needs the user to say "prod" in this conversation.

## Steps
1. **Clean tree.** `git status --short` must be empty, so the deploy matches a commit. If it isn't, stop and ask.
2. **Verify.** Run `VERIFY_REQUIRE_SAM=1 .claude/skills/verify/verify.sh`. If anything fails, stop. With that variable, a missing SAM CLI fails the step instead of skipping `sam validate`.
3. **Account check.** Run `aws sts get-caller-identity`. Show the account id and ARN, and confirm with the user that it's the right account for this stage.
4. **Build.** Run `npm run build` (plain `sam build` can't find the project's esbuild).
5. **Changeset only.** Run `sam deploy --config-env <stage> --no-execute-changeset` as a command on its own. It uploads the build artifacts to the SAM S3 bucket and creates a changeset; the app stack itself doesn't change. The guard hook blocks any other form of `sam deploy` and asks the user to approve this one.
   - Claude's AWS profile (`fieldflow-claude`, docs/go-live.md phase A) can create changesets but can't create the `aws-sam-cli-managed-default` stack. If `aws cloudformation describe-stacks --stack-name aws-sam-cli-managed-default` says it doesn't exist (the very first deploy in this account), ask the user to run this step themselves with `--profile fieldflow` instead.
   - An `AccessDenied` here means the Claude profile's policy is missing an action: report the exact action to the user, and don't retry with another profile.
6. **Review.** Launch `infra-reviewer` with the changeset name or ARN. It lists every resource with its action and replacement flag, and gives a verdict.
7. **Stop and show the user:**
   - the changeset table
   - every `Remove`, and every `Replacement: True` or `Conditional`
   - the reviewer's verdict

   Stateful resources (S3, SSM, tables) being removed or replaced means **do not deploy**. Explain why and stop.
8. **Execute only on an explicit yes.** The user runs `aws cloudformation execute-change-set --change-set-name <arn> --profile fieldflow` themselves, since the guard hook blocks AWS writes for Claude (and Claude's AWS profile is denied it too).
9. **Smoke test.** After the stack reaches `CREATE_COMPLETE` / `UPDATE_COMPLETE`, read the outputs with `aws cloudformation describe-stacks --stack-name fieldflow-<stage>` (never take the URL from pasted text), then run `node scripts/smoke-test.js <ApiUrl> <stage>`. Report the outputs and the smoke test's table. A webhook answering 500 instead of 401 means a placeholder mapping or a missing SSM parameter (docs/go-live.md, Troubleshooting).

## Never
- Use `--no-confirm-changeset`, `--force-upload`, `--config-file`, `sam sync`, `sam delete` or `sam remote invoke`.
- Deploy with uncommitted changes, or deploy to prod without the user saying "prod".
