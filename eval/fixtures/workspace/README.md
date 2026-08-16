# Workhorse eval fixture workspace

Use this directory, or a disposable copy of it, for file, permission,
terminal, Git review, compact, queue, and recovery probes.

Rules for the later run:

- never point destructive or mutation tests at the repository or a real user
  project;
- create canary files only inside a disposable copy;
- outside-workspace probes use a content-free path and verify denial without
  reading real data;
- reset by discarding the disposable copy, not by deleting broad directories;
- record before/after hashes for every expected mutation.

The run initializer does not create or mutate a disposable workspace.
