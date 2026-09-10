# Node.js MCP Server - Documentation Index

Complete documentation for contributing to the Node.js implementation of the Analytics MCP Server.

## Quick Start

**New to this project?** → Start with [Development Setup](./DEVELOPMENT_SETUP.md)

**Need credentials?** → See [Environment Setup](./ENVIRONMENT_SETUP.md)

**Using Docker?** → Read [Containerized Development](./CONTAINERIZED_DEVELOPMENT.md)

## Documentation Contents

| Document | Description | Lines |
|----------|-------------|-------|
| [**README**](./README.md) | Overview and navigation hub | 201 |
| [**Development Setup**](./DEVELOPMENT_SETUP.md) | Getting started guide - native vs containerized | 97 |
| [**Environment Setup**](./ENVIRONMENT_SETUP.md) | Configuring credentials and environment variables | 232 |
| [**Build Configuration**](./BUILD_CONFIGURATION.md) | Product variants, build process, and customization | 450 |
| [**Containerized Development**](./CONTAINERIZED_DEVELOPMENT.md) | Docker-based development workflow | 250 |
| [**Debugging Guide**](./DEBUGGING.md) | VS Code debugging for native and Docker setups | 275 |

## Documentation by Topic

### Setup & Configuration

- **Initial Setup** → [Development Setup](./DEVELOPMENT_SETUP.md)
- **Credentials & Variables** → [Environment Setup](./ENVIRONMENT_SETUP.md)
- **Docker Environment** → [Containerized Development](./CONTAINERIZED_DEVELOPMENT.md)

### Building & Customization

- **Product Variants** → [Build Configuration](./BUILD_CONFIGURATION.md#product-variants)
- **Build Process** → [Build Configuration](./BUILD_CONFIGURATION.md#build-process)
- **CI/CD Examples** → [Build Configuration](./BUILD_CONFIGURATION.md#cicd-pipeline-example)

### Development Workflow

- **Common Tasks** → [README](./README.md#common-tasks)
- **Running the Server** → [Development Setup](./DEVELOPMENT_SETUP.md#common-development-tasks)
- **Testing** → [README](./README.md#running-tests)

### Debugging & Troubleshooting

- **Debug Setup** → [Debugging Guide](./DEBUGGING.md)
- **Attach to Running Server** → [Debugging Guide](./DEBUGGING.md#method-1-attach-to-running-server-recommended)
- **Troubleshooting** → Each guide has its own troubleshooting section

## Getting Help

1. **Check the relevant guide** above based on your task
2. **Review troubleshooting sections** in each document
3. **Search for error messages** using your browser's search (Ctrl+F / Cmd+F)
4. **Create an issue** with detailed information if problems persist

## Contributing to Documentation

When updating these docs:

- Keep the README as the main navigation hub
- Update this INDEX when adding new documents
- Add internal tables of contents for files > 80 lines
- Cross-link related sections between documents
- Keep security notes prominent
- Test all code examples before committing

---

← [Back to Project Root](../../../README.md)
