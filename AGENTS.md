# Project guidance

These instructions apply throughout the project. Read [annotator.md](annotator.md) when working on viewing, annotations, annotation data, or doctor workflows. Read [classifier.md](classifier.md) when working on inference, classification results, or agent assistance. Read both for changes that span these areas; classifier work must also follow the annotation principles in annotator.md.

## Project goals

Build one application for annotating and analyzing H&E whole-slide images of muscle biopsies. The first deliverable is an efficient annotator for a team of doctors reviewing more than 1,000 slides. Extend the same project into an agentic MIL classifier application, reusing the viewer, data, and workflows.

## Local operation

- Prioritize a locally installable application with a browser interface and images stored on local or external hard drives.
- Core viewing, annotation, saving, and configured classifier inference must work without internet access after installation and setup.
- Keep slides, annotations, and results local by default. Do not require cloud accounts or uploads.
- Make installation, startup, backup, and moving a project between computers straightforward.
- Leave room for future web deployment without making it a requirement for the initial application.

## Local data directories

- SSD raw data: `/home/ahmed/Data/HE-MYO/Raw/`
- SSD processed data: `/home/ahmed/Data/HE-MYO/Processed/`
- HDD raw data: `/home/ahmed/Data/HDD/Data/HE-MYO/Raw/`
- HDD processed data: `/home/ahmed/Data/HDD/Data/HE-MYO/Processed/`

## Technology directions

- Use React and TypeScript with CSS for the browser interface, keeping dependencies small. Reuse OpenSeadragon for whole slide viewing and add annotation tools where needed.
- Use FastAPI for backend, with established slide-reading libraries such as OpenSlide.
- Bundle frontend assets for offline operation and reuse the same application components for annotation, classification, and future agent interactions.

## Development approach

- Deliver the local annotator first, then integrate inference and agent assistance incrementally.
- Favor simple, maintainable components and reuse established whole-slide imaging capabilities.
- Avoid premature distributed infrastructure or commitments to specific frameworks before assessing project needs.
- Validate usability with doctors and representative slides early. Protect original images and existing annotations throughout development.
