# Daily customer walkthrough and reported-layout fixes

**24 browser checks passed, 59 screenshots, zero assertion failures. All 361 backend tests passed.** This run used the actual public client release `8cb9a63a0b4e7090`, served from product snapshot `9740d7ef`.

[Open deployed demo](https://codoxear.gzeek.com:8444/?release=8cb9a63a0b4e7090) · [Draft PR](https://github.com/jackw1997/codoxear/pull/1) · [Full browser results](results.json) · [Verification boundaries](verification.json) · [Deployment](deployment.json) · [Backend TAP](backend-final.tap)

The screenshots below start with the two reported layouts, then show ownership initialization, two identities, invitation, two Computers, explicit allowlists, agent creation and daily actions. Application mutations used browser clicks, forms and file choosers. No accounts, credentials or grants were seeded through backend APIs or database edits.

Google/Feishu chooser pages and model responses were controlled fixtures. Real managed runtime, Computer service, authorization, storage, queue, attachment and file operations were exercised. Installing/enrolling/starting the Computer service and preparing pre-existing workspace files were disclosed external infrastructure. The run does not establish real provider/model acceptance or physical mobile/Safari acceptance.

Git comparison shown below comes from a separately recorded 20-check focused rerun that waits for actual visible inserted-line decorations; it is not another full 24-check run. [Focused results](git-visual-results.json). The original full-run frame remains [available](daily-git-diff.png). The update notice is from a separate two-check run, not the customer screenshot count. [Update results](client-update-results.json).

Browser diagnostics are retained, including permission-denial responses and background polling without a permitted agent. Features absent from the exercised card (star/archive/manual drag controls), external native-session import, live model/provider acceptance and physical mobile acceptance are listed in the results rather than claimed as tested. Earlier [R55 screenshots](../customer-journey/) remain historical.

## Reported layout: Hub settings on a phone

![Reported layout: Hub settings on a phone](customer-hub-settings-portrait.png)

## Reported layout: Computer allowlist on a phone

![Reported layout: Computer allowlist on a phone](customer-computer-allowlist-portrait.png)

## Initialization offers separate provider choices

![Initialization offers separate provider choices](initialization-provider-choice.png)

## initialization controlled provider

![initialization controlled provider](initialization-controlled-provider.png)

## First verified identity becomes Owner

![First verified identity becomes Owner](initialized-owner.png)

## provider owner

![provider owner](provider-owner.png)

## empty owner hub

![empty owner hub](empty-owner-hub.png)

## owner hub settings role

![owner hub settings role](owner-hub-settings-role.png)

## customer hub settings landscape

![customer hub settings landscape](customer-hub-settings-landscape.png)

## computer a pairing

![computer a pairing](computer-a-pairing.png)

## computer a write

![computer a write](computer-a-write.png)

## customer computer allowlist landscape

![customer computer allowlist landscape](customer-computer-allowlist-landscape.png)

## provider member

![provider member](provider-member.png)

## member before invitation

![member before invitation](member-before-invitation.png)

## Owner invites the second identity

![Owner invites the second identity](owner-created-invitation.png)

## member joined no computers

![member joined no computers](member-joined-no-computers.png)

## computer b pairing

![computer b pairing](computer-b-pairing.png)

## computer b write

![computer b write](computer-b-write.png)

## Owner sees both Computers but cannot execute on B without a grant

![Owner sees both Computers but cannot execute on B without a grant](owner-sees-both-with-b-blocked.png)

## Member sees only explicitly allowed Computer B

![Member sees only explicitly allowed Computer B](member-sees-only-b.png)

## owner agent a create

![owner agent a create](owner-agent-a-create.png)

## owner agent a reply

![owner agent a reply](owner-agent-a-reply.png)

## owner view file

![owner view file](owner-view-file.png)

## member agent b create

![member agent b create](member-agent-b-create.png)

## member agent b reply

![member agent b reply](member-agent-b-reply.png)

## Missing workspace permission has no create-file bypass

![Missing workspace permission has no create-file bypass](member-files-denied-without-create.png)

## owner grants member b files

![owner grants member b files](owner-grants-member-b-files.png)

## member details

![member details](member-details.png)

## member view file

![member view file](member-view-file.png)

## member unattended saved

![member unattended saved](member-unattended-saved.png)

## computer b read

![computer b read](computer-b-read.png)

## member read only history

![member read only history](member-read-only-history.png)

## computer b revoked

![computer b revoked](computer-b-revoked.png)

## Revoked Member loses Computer and agent access

![Revoked Member loses Computer and agent access](member-revoked.png)

## daily settings slate dark

![daily settings slate dark](daily-settings-slate-dark.png)

## daily voice settings cancelled

![daily voice settings cancelled](daily-voice-settings-cancelled.png)

## daily help

![daily help](daily-help.png)

## daily copy conversation

![daily copy conversation](daily-copy-conversation.png)

## daily conversation search

![daily conversation search](daily-conversation-search.png)

## daily queued message

![daily queued message](daily-queued-message.png)

## daily interrupted queue completed

![daily interrupted queue completed](daily-interrupted-queue-completed.png)

## daily file created saved

![daily file created saved](daily-file-created-saved.png)

## daily model changed

![daily model changed](daily-model-changed.png)

## daily model persisted

![daily model persisted](daily-model-persisted.png)

## daily attachment staged

![daily attachment staged](daily-attachment-staged.png)

## daily file and image ready

![daily file and image ready](daily-file-and-image-ready.png)

## daily file and image sent

![daily file and image sent](daily-file-and-image-sent.png)

## daily preview markdown

![daily preview markdown](daily-preview-markdown.png)

## daily preview image

![daily preview image](daily-preview-image.png)

## daily preview pdf

![daily preview pdf](daily-preview-pdf.png)

## Git comparison shows actual inserted lines (separate focused rerun)

![Git comparison shows actual inserted lines (separate focused rerun)](daily-git-diff-visual.png)

## daily promoted admin

![daily promoted admin](daily-promoted-admin.png)

## daily admin sees computers without usage

![daily admin sees computers without usage](daily-admin-sees-computers-without-usage.png)

## daily two provider identities one device

![daily two provider identities one device](daily-two-provider-identities-one-device.png)

## daily duplicate private credentials required

![daily duplicate private credentials required](daily-duplicate-private-credentials-required.png)

## daily duplicate created

![daily duplicate created](daily-duplicate-created.png)

## daily deleted after reload

![daily deleted after reload](daily-deleted-after-reload.png)

## daily renamed snoozed

![daily renamed snoozed](daily-renamed-snoozed.png)

## daily renamed priority persisted

![daily renamed priority persisted](daily-renamed-priority-persisted.png)

## update available phone

![update available phone](update-available-phone.png)
