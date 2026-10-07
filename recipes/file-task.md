---
name: file-task
description: Do the ticket's task on the files attached to it; every edit and deletion can be undone
mode: files
permissions: { edit_files: true, delete_files: true }
timeout_min: 10
inputs: [ticket, notes, history]
outputs: [summary, next_action]
---
Carry out this ticket's task on its attached files, as its description asks.

1. Read the description's Goal and Done when, and the owner notes. They say what should happen to which files.
2. Read each attached file's copy before deciding anything about it. A file listed as no longer existing needs no action; say so.
3. Act only where the description asks for it and the file's content supports it. If the description says to check something before deleting (for example that nothing in the file exists only there), check it against what you can read and say what you found. If you cannot tell, do not delete; explain what a person needs to check.
4. Change only what the task needs. Leave every other attached file as it is.

Summary: for each attached file, what you did (deleted, edited, left alone) and why, citing what you read. Suggest as the next action whatever is left for a person, such as confirming the result and closing the ticket.
