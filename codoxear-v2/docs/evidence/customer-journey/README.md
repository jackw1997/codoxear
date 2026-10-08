# Browser customer walkthrough

9 journey checks, 32 screenshots, zero failures. Application mutations use browser clicks and forms. Controlled Google/Feishu provider pages and deterministic model responses isolate the UI and authorization flow. Computer service enrollment/start is external infrastructure, using the browser-generated pairing code; this is not browser-only machine deployment or real-provider/model acceptance.

[Results](results.json) · [Verification boundaries](verification.json) · [Deployed snapshots](deployment.json) · [Demo](https://codoxear.gzeek.com:8444/)

## Initialization: parallel provider choices

![Initialization: parallel provider choices](initialization-provider-choice.png)

## First identity becomes Owner

![First identity becomes Owner](initialized-owner.png)

## Owner creates Computer A; pairing credentials masked

![Owner creates Computer A; pairing credentials masked](computer-a-pairing.png)

## Owner explicitly grants Computer A access

![Owner explicitly grants Computer A access](computer-a-write.png)

## Owner creates invitation for the second verified identity

![Owner creates invitation for the second verified identity](owner-created-invitation.png)

## Invited Member joins but has no Computer grant

![Invited Member joins but has no Computer grant](member-joined-no-computers.png)

## Owner explicitly grants Computer B to the Member

![Owner explicitly grants Computer B to the Member](computer-b-write.png)

## Owner sees both Computers; B is not allowlisted for execution

![Owner sees both Computers; B is not allowlisted for execution](owner-sees-both-with-b-blocked.png)

## Member sees only Computer B

![Member sees only Computer B](member-sees-only-b.png)

## Member sets explicit private-provider launch options

![Member sets explicit private-provider launch options](member-agent-b-create.png)

## Member creates an agent and sends through the web UI

![Member creates an agent and sends through the web UI](member-agent-b-reply.png)

## Files explains missing workspace permission and hides creation

![Files explains missing workspace permission and hides creation](member-files-denied-without-create.png)

## Owner separately grants workspace files through UI

![Owner separately grants workspace files through UI](owner-grants-member-b-files.png)

## Member opens the permitted workspace file

![Member opens the permitted workspace file](member-view-file.png)

## Managed Details opens actual retained metadata

![Managed Details opens actual retained metadata](member-details.png)

## Managed Unattended settings save and reopen

![Managed Unattended settings save and reopen](member-unattended-saved.png)

## Read-only access preserves history and disables Send

![Read-only access preserves history and disables Send](member-read-only-history.png)

## Completed discovery after revocation: no Computers or sessions

![Completed discovery after revocation: no Computers or sessions](member-revoked.png)

## Phone layout: Hub administration and Google Owner identity

![Phone layout: Hub administration and Google Owner identity](customer-hub-settings-portrait.png)

## Phone layout: explicit Computer grants and workspace navigation

![Phone layout: explicit Computer grants and workspace navigation](customer-computer-allowlist-portrait.png)
