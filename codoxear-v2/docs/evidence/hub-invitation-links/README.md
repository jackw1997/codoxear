# Hub invitation: create a link → sign in → explicitly join

**24 public browser checks passed, zero failures, 69 masked screenshots. Backend: 367/367 passed.**

[Open deployed demo](https://codoxear.gzeek.com:8444/?release=b973cd6ddae05395) · [Draft PR](https://github.com/jackw1997/codoxear/pull/1) · [Exact verification](verification.json) · [Full results](results.json) · [Backend TAP](backend-final.tap) · [Deployment](deployment.json)

Owner/Admin opens Hubs & computers → Hub settings → Manage Hub members, creates an expiring single-use Member link and shares it. The recipient opens it, signs in with an allowed provider or selects a saved identity, then explicitly chooses Join Hub. Opening or signing in does not join or consume the invitation. Computer/workspace access and Owner-only Admin promotion remain separate. The Owner does not accept an invitation to its own Hub.

These are actual deployed client screens at asset `b973cd6ddae05395`, product `77714b33`. Application mutations use browser controls, with no backend account/credential/grant seeding. Google/Feishu pages and model responses are controlled fixtures around real authorization, managed runtime, Computer and file operations. Installing/enrolling/starting Computers and preparing workspace fixtures are external infrastructure. Secrets are masked in pink; that is screenshot masking, not the product appearance.

The final committed harness is `de4bd5f0`; its product source matches the deployed revision. No runtime source or harness overlays were used. Backend closure is unchanged from the full 367-test run at `462df6db`. Prior/rejected runs are recorded separately and not added to these counts. Elapsed expiry is backend clock-tested; live providers/models, native image delivery, physical mobile/Safari and unexercised actions remain explicitly scoped in verification.

## Owner creates and copies a Member invitation before the recipient exists

![Owner creates and copies a Member invitation before the recipient exists](owner-created-invitation.png)

## Recipient opens the link and chooses Google or Feishu

![Recipient opens the link and chooses Google or Feishu](recipient-link-before-sign-in.png)

## Sign-in alone does not join: recipient explicitly chooses Join Hub

![Sign-in alone does not join: recipient explicitly chooses Join Hub](member-signed-in-before-explicit-join.png)

## Joined Member has no Computer grant

![Joined Member has no Computer grant](member-joined-no-computers.png)

## Connected Member gets precise Computer-access guidance

![Connected Member gets precise Computer-access guidance](member-joined-awaiting-computer-access.png)

## Owner cannot join or consume its own invitation

![Owner cannot join or consume its own invitation](owner-cannot-join-own-hub-invitation.png)

## Revoked link cannot admit a recipient

![Revoked link cannot admit a recipient](recipient-revoked-link-denied.png)

## Consumed link cannot admit another recipient

![Consumed link cannot admit another recipient](recipient-used-link-denied.png)

## Admin can create a Member invitation

![Admin can create a Member invitation](daily-admin-created-invitation-link.png)

## Admin can revoke a pending invitation

![Admin can revoke a pending invitation](daily-admin-revoked-pending-invitation.png)

## Hub settings on a phone

![Hub settings on a phone](customer-hub-settings-portrait.png)

## Computer allowlist on a phone

![Computer allowlist on a phone](customer-computer-allowlist-portrait.png)

## Revoked Member loses Computer and agent access

![Revoked Member loses Computer and agent access](member-revoked.png)

<details>
<summary>Remaining initialization, two-Computer and daily-use screenshots</summary>

### initialization provider choice

![initialization provider choice](initialization-provider-choice.png)

### initialization controlled provider

![initialization controlled provider](initialization-controlled-provider.png)

### initialized owner

![initialized owner](initialized-owner.png)

### provider owner

![provider owner](provider-owner.png)

### empty owner hub

![empty owner hub](empty-owner-hub.png)

### owner hub settings role

![owner hub settings role](owner-hub-settings-role.png)

### customer hub settings landscape

![customer hub settings landscape](customer-hub-settings-landscape.png)

### computer a pairing

![computer a pairing](computer-a-pairing.png)

### computer a write

![computer a write](computer-a-write.png)

### customer computer allowlist landscape

![customer computer allowlist landscape](customer-computer-allowlist-landscape.png)

### owner pending link before recipient

![owner pending link before recipient](owner-pending-link-before-recipient.png)

### owner revoked pending link

![owner revoked pending link](owner-revoked-pending-link.png)

### provider member

![provider member](provider-member.png)

### member explicitly joined hub

![member explicitly joined hub](member-explicitly-joined-hub.png)

### computer b pairing

![computer b pairing](computer-b-pairing.png)

### computer b write

![computer b write](computer-b-write.png)

### owner sees both with b blocked

![owner sees both with b blocked](owner-sees-both-with-b-blocked.png)

### member sees only b

![member sees only b](member-sees-only-b.png)

### owner agent a create

![owner agent a create](owner-agent-a-create.png)

### owner agent a reply

![owner agent a reply](owner-agent-a-reply.png)

### owner view file

![owner view file](owner-view-file.png)

### member agent b create

![member agent b create](member-agent-b-create.png)

### member agent b reply

![member agent b reply](member-agent-b-reply.png)

### member files denied without create

![member files denied without create](member-files-denied-without-create.png)

### owner grants member b files

![owner grants member b files](owner-grants-member-b-files.png)

### member details

![member details](member-details.png)

### member view file

![member view file](member-view-file.png)

### member unattended saved

![member unattended saved](member-unattended-saved.png)

### computer b read

![computer b read](computer-b-read.png)

### member read only history

![member read only history](member-read-only-history.png)

### computer b revoked

![computer b revoked](computer-b-revoked.png)

### daily settings slate dark

![daily settings slate dark](daily-settings-slate-dark.png)

### daily voice settings cancelled

![daily voice settings cancelled](daily-voice-settings-cancelled.png)

### daily help

![daily help](daily-help.png)

### daily copy conversation

![daily copy conversation](daily-copy-conversation.png)

### daily conversation search

![daily conversation search](daily-conversation-search.png)

### daily queued message

![daily queued message](daily-queued-message.png)

### daily interrupted queue completed

![daily interrupted queue completed](daily-interrupted-queue-completed.png)

### daily file created saved

![daily file created saved](daily-file-created-saved.png)

### daily model changed

![daily model changed](daily-model-changed.png)

### daily model persisted

![daily model persisted](daily-model-persisted.png)

### daily attachment staged

![daily attachment staged](daily-attachment-staged.png)

### daily file and image ready

![daily file and image ready](daily-file-and-image-ready.png)

### daily file and image sent

![daily file and image sent](daily-file-and-image-sent.png)

### daily preview markdown

![daily preview markdown](daily-preview-markdown.png)

### daily preview image

![daily preview image](daily-preview-image.png)

### daily preview pdf

![daily preview pdf](daily-preview-pdf.png)

### daily git diff

![daily git diff](daily-git-diff.png)

### daily promoted admin

![daily promoted admin](daily-promoted-admin.png)

### daily admin sees computers without usage

![daily admin sees computers without usage](daily-admin-sees-computers-without-usage.png)

### daily two provider identities one device

![daily two provider identities one device](daily-two-provider-identities-one-device.png)

### daily duplicate private credentials required

![daily duplicate private credentials required](daily-duplicate-private-credentials-required.png)

### daily duplicate created

![daily duplicate created](daily-duplicate-created.png)

### daily deleted after reload

![daily deleted after reload](daily-deleted-after-reload.png)

### daily renamed snoozed

![daily renamed snoozed](daily-renamed-snoozed.png)

### daily renamed priority persisted

![daily renamed priority persisted](daily-renamed-priority-persisted.png)

</details>
