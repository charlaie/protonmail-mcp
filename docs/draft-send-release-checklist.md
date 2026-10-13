# Mail workflow release check

Automated regressions simulate IMAP boundaries and use a local SMTP server. They do not establish live Proton Bridge synchronization or client approval presentation. Complete this checklist before declaring these workflows ready for production. Use a dedicated test account, isolated operation directory, and recipients controlled by the tester. Record Bridge, OS, server and client versions with results.

## Draft synchronization

- Create an empty draft, a draft with To/Cc/Bcc, and a long Unicode body. Verify each appears once in Proton web and mobile, with the same subject, recipients and text.
- Read its revision and patch only the body. Verify recipients and subject remain intact. Clear recipient arrays and strings explicitly, then verify the unfinished draft remains readable.
- Verify reply and reply-all honor Reply-To, deduplicate grouped recipients, omit original Bcc, exclude own addresses and select configured aliases. Check threading in Proton web and mobile.
- Edit with an outdated revision after a Proton client change. Verify no replacement appears. Confirm arbitrary HTML drafts are refused intact. Attach files, including zero-byte files and non-UTF-8 text with a declared charset, then patch the body and verify exact bytes, declared MIME and filenames survive.
- Create PNG/JPEG/GIF inline-image drafts with empty text, Unicode, CRLF, markup-like text and descriptions. Verify CID rendering in Proton web/mobile, plain-text alternatives, and preservation across patch edits and sending. Confirm SVG, malformed signatures and oversized images are refused.
- Verify Bridge-added headers do not prevent exact-content APPEND reconciliation. Verify actual recipient, body, subject or reply-header changes do prevent it.

## Approval and submission

- In every supported MCP client and protocol mode, inspect sender alias, every To/Cc/Bcc recipient, subject, threading metadata, the entire body and file/image manifests including filenames, MIME/charset, decoded sizes, SHA-256 digests, CID and descriptions. Verify base64 bytes never appear in approval prompts or operation outputs. Test a body near 100,000 characters, Unicode and text resembling markup or instructions. Ensure the client gives the user access to every character before approval.
- Cancel, decline and expire approval, and remove elicitation support. Verify SMTP never starts. Reuse approval request state with changed content and verify refusal.
- Change the draft or read policy while approval is open. Verify the continuation refuses submission.
- Approve one test message and verify exactly one submission, reply threading and no Bcc disclosure in delivered headers. Verify the accepted result separately from recipient delivery and draft deletion.

## Forwarding

- Forward an allowed original with a new recipient and introduction. Verify source headers/plain text are quoted, original Bcc and attachments are omitted, and the original stays unchanged.
- Select an original attachment using list/get tools with incoming extension restrictions and optional human approval. Add its approved bytes to the forward, approve the send separately, and verify exact delivery bytes. A forward must not automatically include unselected source files.
- Cancel or expire forward approval and verify no submission. Change the source or read policy during approval and verify refusal. Retry a submitted operation UUID after restart and verify no second SMTP attempt.

## Inbox management

- Confirm old policies disable writes. Grant only selected actions and source/destination paths through setup. Verify denied actions, senders and destinations cannot change mail; revoke policy before execution and verify refusal.
- Verify read/unread and star/unstar synchronize to Proton web/mobile and preserve unrelated flags. Test unstar from Starred and read state through All Mail. Confirm placement actions refuse both views.
- Archive, move and Trash controlled messages through native MOVE. Verify source/destination identities and web/mobile placement. Confirm Bridge advertises MOVE and permanent Seen/Flagged support; lack of support must refuse the relevant action.
- Apply an existing label from an ordinary folder and verify that folder remains unchanged. Remove the label to an explicit ordinary folder and verify both label removal and the chosen folder. Verify generic moves cannot implicitly change labels.
- Restart and repeat completed operation UUIDs without another write. Interrupt a MOVE or STORE acknowledgment, verify uncertainty and retained claims, and reconcile only with positive evidence. Verify missing or duplicate evidence cannot release a claim. Keep `submitting` operations reserved until manual inspection with all account processes stopped.
- Compete inbox operations across processes and folder/label projections. Verify draft/send claims block inbox writes and unresolved inbox claims block competing writes. Confirm these tools cannot mutate Drafts or permanently delete mail.

## Failure and recovery

- Interrupt the server around APPEND and restart it with the same journal. Retry the original UUID and verify no second APPEND. Use get/list/reconcile tools to find the saved draft; no exact match must keep uncertainty.
- Interrupt an edit between APPEND and original deletion. Verify both copies stay discoverable, the original cannot start another mutation, and the replacement remains blocked until safe cleanup. Change either copy before cleanup and verify the original is retained.
- Run two server processes sharing one local journal. Compete two edits, two sends, and an edit with a send. Verify one external attempt and durable conflict responses.
- Interrupt SMTP after DATA, and simulate partial recipient acceptance on a controlled test server. Verify the draft stays present, edits cannot turn it into a resendable replacement, and cleanup-only retries refuse those outcomes.
- Interrupt deletion after accepted SMTP. Retry send cleanup and verify no SMTP submission. Change the draft first and verify it is retained; delete it externally and verify cleanup recognizes absence after checking UIDVALIDITY.
- Change mailbox UIDVALIDITY and verify old identities never delete or send newly assigned UIDs. Temporarily withhold source content for an existing UID and verify cleanup remains unresolved.
- Make the journal unavailable and verify writes fail before submission. Restore it and inspect operation IDs. Check file permissions and account isolation. Test metadata inspection with missing policy, then verify reconciliation and deletion still require restored authorization.
- Back up the journal with every server process stopped. Restore that current backup into the same account configuration and verify accepted and uncertain operation IDs cannot resubmit. Do not use stale backups for retry decisions.

## Release evidence

Record automated test output and completed live checks, including any Bridge normalization or unsupported-client behavior. Keep the workflow labeled as unvalidated for any supported platform or client whose checks remain incomplete. Arbitrary HTML composition remains unsupported; supported images use the escaped CID rendering.
