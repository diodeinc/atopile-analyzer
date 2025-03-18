# atopile-analyzer Development Guide

## Build & Test Commands
- Build: `cargo build` (all crates) or `cargo build -p atopile_parser` (specific crate)
- Release build: `cargo build --release`
- Run all tests: `cargo test`
- Run specific test: `cargo test resistors` or `cargo test -p atopile_parser resistors`
- Linting: `cargo clippy`
- Formatting: `cargo fmt`
- Install VSCode extension: `./crates/atopile_lsp/install.sh`

## Code Style Guidelines
- **Naming**: PascalCase for types, snake_case for functions/variables
- **Imports**: Group standard lib, external crates, then internal modules
- **Error Handling**: Use `anyhow` for context, `thiserror` for custom errors
- **Type System**: Leverage strong typing, Rust enums, and proper trait implementation
- **Documentation**: Document public APIs with rustdoc comments
- **Testing**: Use insta snapshots for output validation
- **Ownership**: Follow Rust's ownership model with appropriate lifetimes
- **Formatting**: Use standard Rust formatting conventions
- **Modules**: Maintain clean separation of concerns between crates and modules