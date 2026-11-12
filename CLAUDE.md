# WAAPRO LTD: permanent development and update policy

This policy is set by the owner and applies to every WAAPRO LTD system. It
applies to the systems that exist today and to every system added later. It
overrides any older note in this repository that says otherwise.

## The systems

| # | System | Repository | Backend | Admin dashboard | Production branch |
|---|--------|------------|---------|-----------------|-------------------|
| 1 | DALAB | waaproltd-spec/Dalab-internet | `admin-backend-ts` | `super-admin-app` | `claude/agent-operations` |
| 2 | Danwadaag | waaproltd-spec/Danwadaag | `admin-backend-ts` | `super-admin-app` | `claude/agent-operations` |
| 3 | Fududeeye | waaproltd-spec/Fududeeye-data | `backend` | `admin-dashboard` | `claude/agent-stage2` |
| 4 | Sahal | waaproltd-spec/Info-sahal-data | `backend` | `admin-dashboard` | `claude/agent-stage2` |

Shared parts:
- The **AGENT APP** (`waapro-agent-app/` in Dalab-internet) is one app for
  every system. Release branch: `claude/unified-agent-app`. Only that branch
  publishes an APK.
- The **Admin Hub** (`admin-hub/` in Danwadaag) contains `deploy/deploy-all.sh`.
  That script backs up, updates and verifies all systems together.

**A fifth or later system** follows this policy from its first day. When one
is created:
- add it to the table above in every repository;
- add it to `SYSTEMS` in `admin-hub/deploy/deploy-all.sh`;
- add it to the Admin Hub;
- copy this file into its repository;
- bring it up to the same feature level as the others.

## The rules

1. **No system is left behind.** Every new feature, improvement and bug fix
   goes to every system it is relevant to, including newly added systems. The
   systems share the same code base, so port the same change to each of them
   and test each one. If a change truly does not apply to a system, say which
   system and why.

2. **Customer apps stay compatible.**
   - Existing customer app versions must keep working.
   - Deliver changes through the backend/API whenever technically possible,
     so customers do not have to install a new APK.
   - Do not remove or rename API fields, routes or response shapes that
     released customer apps use. Add new ones instead.

3. **A new customer APK needs the owner's approval first.** If a change
   cannot be delivered without a new customer APK, explain why. Get the
   owner's approval before building or publishing it.

4. **Test before deployment.** For every affected system:
   - Run its builds (backend type-check and build, dashboard build, app
     build) and its tests. Add tests for new behaviour.
   - Verify that existing services and payment functions still work: orders,
     payments, USSD, SMS matching, wallets and withdrawals.
   - Report any test that already failed before the change as pre-existing,
     with proof, separately from new failures.

5. **Back up before deployment.** Before production is touched, back up
   every affected database and the important files: `.env` and pm2
   settings, and the dashboards. `deploy-all.sh` does this, and it stops if
   a backup fails.

6. **Feature branches until approved.**
   - All work stays on separate feature branches until the owner explicitly
     approves production deployment.
   - Do not merge into a production branch or the Agent App release branch,
     run a deployment, or publish an APK or release without that approval.
   - Approval for one change is not approval for the next.

7. **Never repeat an uncertain financial transaction automatically.** A
   payment or USSD transaction with an unknown result must be shown to a
   person to check. It must never be dialed or sent again automatically. Do
   not change existing payment logic unless the owner asked for it.

8. **Use real data only.** Never show fake or placeholder numbers.
