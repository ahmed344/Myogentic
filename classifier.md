# Classifier and agent guidance

Apply this guidance alongside the shared instructions in [AGENTS.md](AGENTS.md) and the annotation principles in [annotator.md](annotator.md).

## Classifier repository

- The local WSI-Classification repository is at `/home/ahmed/Repositories/WSI-Classification`.

## Technology directions

- Keep model inference in a separate container and favor a simple local setup.

## Classifier and agent capabilities

- Integrate the classifier through a separate containerized inference component within a simple modular application.
- Support overlapping pattern predictions and graded abnormality, aligned with the agreed annotations.
- Keep viewing and annotation responsive during analysis. Show progress, failures, and completed results clearly; reuse compatible existing features and results.
- Record which model and processing configuration produced each result.
- Enable an agent to help navigate cases, retrieve evidence, run analyses, compare results, and summarize findings through the application's existing capabilities.
- Agent features must not make ordinary workflows depend on internet access. Any external AI connection must be optional and explicitly configured.
