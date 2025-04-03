use std::{
    fmt::Debug,
    hash::Hash,
    ops::{Deref, Range},
    path::{Path, PathBuf},
};

#[cfg(test)]
use insta::assert_debug_snapshot;
use serde::Serialize;

pub mod lexer;
pub mod parser;

pub type Span = Range<usize>;

#[derive(Clone, Debug, PartialEq, Hash, Eq, Serialize)]
pub struct Spanned<T>(T, Span);

impl<T> Deref for Spanned<T> {
    type Target = T;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<T> From<(T, Span)> for Spanned<T> {
    fn from((item, span): (T, Span)) -> Self {
        Self(item, span)
    }
}

impl<T: ToOwned> Spanned<&T> {
    pub fn to_owned(&self) -> Spanned<T::Owned> {
        Spanned(self.0.to_owned(), self.1.clone())
    }
}

impl<T> Spanned<T> {
    pub fn take(self) -> T {
        self.0
    }

    pub fn span(&self) -> &Span {
        &self.1
    }

    pub fn map<U>(self, f: impl FnOnce(T) -> U) -> Spanned<U> {
        Spanned(f(self.0), self.1.clone())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Position {
    pub line: usize,
    pub column: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AtopileErrorReport<T> {
    span: Span,
    reason: String,
    expected: Vec<Option<T>>,
    found: Option<T>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AtopileError {
    Lexer(AtopileErrorReport<char>),
    Parser(AtopileErrorReport<lexer::Token>),
}

impl<T: Hash + Eq + Debug + Clone> From<chumsky::error::Simple<T>> for AtopileErrorReport<T> {
    fn from(err: chumsky::error::Simple<T>) -> Self {
        Self {
            span: err.span(),
            reason: format!("{:?}", err.reason()),
            expected: err
                .expected()
                .map(|t| t.clone().map(|t| t.clone()))
                .collect(),
            found: err.found().map(|t| t.clone()),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AtopileSource {
    raw: String,
    path: PathBuf,
    tokens: Vec<Spanned<lexer::Token>>,
    ast: Vec<Spanned<parser::Stmt>>,
    line_to_index: Vec<usize>,
}

impl AtopileSource {
    pub fn new(raw: String, path: PathBuf) -> (Self, Vec<AtopileError>) {
        let mut errors: Vec<AtopileError> = Vec::new();

        let (tokens, lexer_errors) = lexer::lex(&raw);
        errors.extend(
            lexer_errors
                .into_iter()
                .map(|e| AtopileError::Lexer(e.into())),
        );

        let (mut ast, parser_errors) = parser::parse(&tokens);
        errors.extend(
            parser_errors
                .into_iter()
                .map(|e| AtopileError::Parser(e.into())),
        );

        // The spans on the original token stream are w.r.t. the token stream, so we traverse the
        // generated AST and rewrite the spans to reference raw characters in the source file.
        for stmt in &mut ast {
            Self::rewrite_span(&tokens, stmt);
            Self::rewrite_stmt(&tokens, stmt);
        }

        let line_to_index = vec![0]
            .into_iter()
            .chain(
                tokens
                    .iter()
                    .filter(|t| matches!(t.0, lexer::Token::Newline))
                    .map(|t| t.span().end),
            )
            .collect::<Vec<_>>();

        (
            Self {
                raw,
                tokens,
                ast,
                line_to_index,
                path,
            },
            errors,
        )
    }

    fn rewrite_span<T>(tokens: &Vec<Spanned<lexer::Token>>, spanned: &mut Spanned<T>) {
        let start = tokens
            .get(spanned.span().start)
            .map(|t| t.1.start)
            .unwrap_or(0);
        let end = tokens
            .get(spanned.span().end.saturating_sub(1))
            .map(|t| t.1.end)
            .unwrap_or(0);

        (*spanned).1 = start..end;
    }

    fn rewrite_stmt(tokens: &Vec<Spanned<lexer::Token>>, stmt: &mut Spanned<parser::Stmt>) {
        match &mut stmt.0 {
            parser::Stmt::Import(stmt) => {
                Self::rewrite_span(tokens, &mut stmt.from_path);
                for import in &mut stmt.imports {
                    Self::rewrite_span(tokens, import);
                }
            }
            parser::Stmt::DepImport(stmt) => {
                Self::rewrite_span(tokens, &mut stmt.name);
                Self::rewrite_span(tokens, &mut stmt.from_path);
            }
            parser::Stmt::Attribute(stmt) => {
                Self::rewrite_span(tokens, &mut stmt.name);
                Self::rewrite_span(tokens, &mut stmt.type_info);
            }
            parser::Stmt::Assign(stmt) => {
                Self::rewrite_span(tokens, &mut stmt.target);
                Self::rewrite_span(tokens, &mut stmt.value);

                Self::rewrite_port_ref(tokens, &mut stmt.target.0);
                Self::rewrite_expr(tokens, &mut stmt.value.0);
            }
            parser::Stmt::Connect(stmt) => {
                Self::rewrite_span(tokens, &mut stmt.left);
                Self::rewrite_span(tokens, &mut stmt.right);

                Self::rewrite_connectable(tokens, &mut stmt.left.0);
                Self::rewrite_connectable(tokens, &mut stmt.right.0);
            }
            parser::Stmt::Block(stmt) => {
                Self::rewrite_span(tokens, &mut stmt.kind);
                Self::rewrite_span(tokens, &mut stmt.name);
                if let Some(parent) = &mut stmt.parent {
                    Self::rewrite_span(tokens, parent);
                }

                for stmt in &mut stmt.body {
                    Self::rewrite_span(tokens, stmt);
                    Self::rewrite_stmt(tokens, stmt);
                }
            }
            parser::Stmt::Signal(stmt) => {
                Self::rewrite_span(tokens, &mut stmt.name);
            }
            parser::Stmt::Pin(stmt) => {
                Self::rewrite_span(tokens, &mut stmt.name);
            }
            parser::Stmt::Assert(stmt) => {
                Self::rewrite_span(tokens, &mut stmt.expr);
                Self::rewrite_expr(tokens, &mut stmt.expr.0);
            }
            parser::Stmt::Comment(stmt) => {
                Self::rewrite_span(tokens, &mut stmt.comment);
            }
            parser::Stmt::Specialize(stmt) => {
                Self::rewrite_span(tokens, &mut stmt.port);
                Self::rewrite_span(tokens, &mut stmt.value);

                Self::rewrite_port_ref(tokens, &mut stmt.port.0);
            }
            parser::Stmt::Pass | parser::Stmt::Unparsable(_) => {}
        }
    }

    fn rewrite_expr(tokens: &Vec<Spanned<lexer::Token>>, expr: &mut parser::Expr) {
        match expr {
            parser::Expr::String(s) => Self::rewrite_span(tokens, s),
            parser::Expr::Number(n) => Self::rewrite_span(tokens, n),
            parser::Expr::Port(p) => {
                Self::rewrite_span(tokens, p);
                Self::rewrite_port_ref(tokens, &mut p.0);
            }
            parser::Expr::New(n) => Self::rewrite_span(tokens, n),
            parser::Expr::Bool(b) => Self::rewrite_span(tokens, b),
            parser::Expr::BinaryOp(b) => {
                Self::rewrite_span(tokens, b);
                Self::rewrite_span(tokens, &mut b.0.left);
                Self::rewrite_span(tokens, &mut b.0.op);
                Self::rewrite_span(tokens, &mut b.0.right);

                Self::rewrite_expr(tokens, &mut b.0.left.0);
                Self::rewrite_expr(tokens, &mut b.0.right.0);
            }
            parser::Expr::Physical(p) => {
                Self::rewrite_span(tokens, p);
                Self::rewrite_span(tokens, &mut p.0.value);
                if let Some(unit) = &mut p.0.unit {
                    Self::rewrite_span(tokens, unit);
                }
                if let Some(tolerance) = &mut p.0.tolerance {
                    Self::rewrite_span(tokens, tolerance);

                    match &mut tolerance.0 {
                        parser::Tolerance::Bilateral { value, unit } => {
                            Self::rewrite_span(tokens, value);

                            if let Some(unit) = unit {
                                Self::rewrite_span(tokens, unit);
                            }
                        }
                        parser::Tolerance::Bound { min, max } => {
                            Self::rewrite_span(tokens, min);
                            Self::rewrite_span(tokens, max);
                        }
                    }
                }
            }
        }
    }

    fn rewrite_port_ref(tokens: &Vec<Spanned<lexer::Token>>, port_ref: &mut parser::PortRef) {
        for part in &mut port_ref.parts {
            Self::rewrite_span(tokens, part);
        }
    }

    fn rewrite_connectable(
        tokens: &Vec<Spanned<lexer::Token>>,
        connectable: &mut parser::Connectable,
    ) {
        match connectable {
            parser::Connectable::Port(p) => {
                Self::rewrite_span(tokens, p);
                Self::rewrite_port_ref(tokens, &mut p.0);
            }
            parser::Connectable::Pin(p) => Self::rewrite_span(tokens, p),
            parser::Connectable::Signal(s) => Self::rewrite_span(tokens, s),
        }
    }

    /// Returns the deepest parser::Stmt that is present at the given index into the source file,
    /// if there is one.
    pub fn stmt_at(&self, index: usize) -> Option<&Spanned<parser::Stmt>> {
        // Keep track of the deepest statement that contains our index
        let mut deepest: Option<&Spanned<parser::Stmt>> = None;
        let mut max_depth = 0;

        // Traverse all statements
        for (stmt, path) in self.traverse_all_stmts() {
            if stmt.span().contains(&index) {
                // If this statement contains our index and is deeper than our current deepest,
                // update our deepest statement
                let depth = path.len();
                if depth >= max_depth {
                    max_depth = depth;
                    deepest = Some(stmt);
                }
            }
        }

        deepest
    }

    pub fn position_to_index(&self, position: Position) -> usize {
        self.line_to_index[position.line] + position.column
    }

    pub fn index_to_position(&self, index: usize) -> Position {
        let line = self
            .line_to_index
            .iter()
            .position(|&i| i > index)
            .unwrap_or(self.line_to_index.len())
            .saturating_sub(1);
        let column = index - self.line_to_index[line];

        Position { line, column }
    }

    pub fn ast(&self) -> &Vec<Spanned<parser::Stmt>> {
        &self.ast
    }

    /// Traverses all statements in the AST, providing each statement along with its parent context
    pub fn traverse_all_stmts(&self) -> StmtTraverser {
        StmtTraverser::new(&self.ast)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

pub struct StmtTraverser<'a> {
    // Stack of iterators for nested blocks
    stack: Vec<(
        std::slice::Iter<'a, Spanned<parser::Stmt>>,
        Option<&'a Spanned<parser::Stmt>>,
    )>,
    // Current path of parent statements leading to current position
    current_path: Vec<&'a Spanned<parser::Stmt>>,
}

impl<'a> StmtTraverser<'a> {
    fn new(stmts: &'a Vec<Spanned<parser::Stmt>>) -> Self {
        Self {
            stack: vec![(stmts.iter(), None)],
            current_path: Vec::new(),
        }
    }

    fn get_block_stmts(stmt: &'a Spanned<parser::Stmt>) -> Option<&'a Vec<Spanned<parser::Stmt>>> {
        match &stmt.0 {
            parser::Stmt::Block(stmt) => Some(&stmt.body),
            _ => None,
        }
    }
}

impl<'a> Iterator for StmtTraverser<'a> {
    type Item = (&'a Spanned<parser::Stmt>, Vec<&'a Spanned<parser::Stmt>>);

    fn next(&mut self) -> Option<Self::Item> {
        while let Some((iter, parent)) = self.stack.last_mut() {
            if let Some(stmt) = iter.next() {
                // If we have a parent statement, ensure it's in the path
                if let Some(parent) = parent {
                    if self.current_path.is_empty() || self.current_path.last() != Some(parent) {
                        self.current_path.push(parent);
                    }
                }

                // If this statement contains a block, push its iterator onto the stack
                if let Some(block_stmts) = Self::get_block_stmts(stmt) {
                    self.stack.push((block_stmts.iter(), Some(stmt)));
                }

                return Some((stmt, self.current_path.clone()));
            } else {
                // No more statements at this level, pop the iterator and its parent
                self.stack.pop();
                self.current_path.pop();
            }
        }
        None
    }
}

#[test]
fn test_index_to_position() {
    let (source, errors) = AtopileSource::new(
        r#"
from "test.ato" import MyModule

from "test2.ato" import MyModule2
    "#
        .trim()
        .to_string(),
        PathBuf::from("test.ato"),
    );

    assert_eq!(errors.len(), 0);

    assert_eq!(source.index_to_position(0), Position { line: 0, column: 0 });
    assert_eq!(
        source.index_to_position(32),
        Position { line: 1, column: 0 }
    );
    assert_eq!(
        source.index_to_position(33),
        Position { line: 2, column: 0 }
    );
}

#[test]
fn test_stmt_at() {
    let (source, errors) = AtopileSource::new(
        r#"
from "test.ato" import MyModule

module M:
    r1 = new Resistor
    r1.value = 100kohm
"#
        .trim()
        .to_string(),
        PathBuf::from("test.ato"),
    );

    assert_eq!(errors.len(), 0);

    assert_debug_snapshot!(
        source.stmt_at(0),
        @r###"
    Some(
        Spanned(
            Import(
                ImportStmt {
                    from_path: Spanned(
                        "test.ato",
                        5..15,
                    ),
                    imports: [
                        Spanned(
                            Symbol(
                                "MyModule",
                            ),
                            23..31,
                        ),
                    ],
                },
            ),
            0..31,
        ),
    )
    "###
    );

    assert_debug_snapshot!(source.stmt_at(48), @r###"
    Some(
        Spanned(
            Assign(
                AssignStmt {
                    target: Spanned(
                        PortRef {
                            parts: [
                                Spanned(
                                    "r1",
                                    47..49,
                                ),
                            ],
                        },
                        47..49,
                    ),
                    type_info: None,
                    value: Spanned(
                        New(
                            Spanned(
                                "Resistor",
                                56..64,
                            ),
                        ),
                        52..64,
                    ),
                },
            ),
            47..64,
        ),
    )
    "###);

    assert_debug_snapshot!(source.stmt_at(1000), @r###"None"###);
}

#[test]
fn test_traverse_all_stmts() {
    let (source, errors) = AtopileSource::new(
        r#"
module M:
    r1 = new Resistor
    r2 = new Resistor
    
    component Sub:
        x = new Thing
"#
        .trim()
        .to_string(),
        PathBuf::from("test.ato"),
    );

    assert_eq!(errors.len(), 0);

    let mut traversal = source.traverse_all_stmts();

    // Module statement with empty path
    let (stmt, path) = traversal.next().unwrap();
    assert!(matches!(stmt.0, parser::Stmt::Block(_)));
    assert!(path.is_empty());

    // First assign statement with module in path
    let (stmt, path) = traversal.next().unwrap();
    assert!(matches!(stmt.0, parser::Stmt::Assign(_)));
    assert_eq!(path.len(), 1);
    assert!(matches!(path[0].0, parser::Stmt::Block(_)));

    // Second assign statement with same path
    let (stmt, path) = traversal.next().unwrap();
    assert!(matches!(stmt.0, parser::Stmt::Assign(_)));
    assert_eq!(path.len(), 1);
    assert!(matches!(path[0].0, parser::Stmt::Block(_)));

    // Component statement with module in path
    let (stmt, path) = traversal.next().unwrap();
    assert!(matches!(stmt.0, parser::Stmt::Block(_)));
    assert_eq!(path.len(), 1);
    assert!(matches!(path[0].0, parser::Stmt::Block(_)));

    // Nested assign with both module and component in path
    let (stmt, path) = traversal.next().unwrap();
    assert!(matches!(stmt.0, parser::Stmt::Assign(_)));
    assert_eq!(path.len(), 2);
    assert!(matches!(path[0].0, parser::Stmt::Block(_)));
    assert!(matches!(path[1].0, parser::Stmt::Block(_)));

    // Should be no more statements
    assert!(traversal.next().is_none());
}
