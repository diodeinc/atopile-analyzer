use std::{
    fmt::{Debug, Display},
    hash::Hash,
    ops::{Deref, Range},
    path::{Path, PathBuf},
};

use chumsky::span::SimpleSpan;
#[cfg(test)]
use insta::assert_debug_snapshot;
use lexer::lex;
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

impl<T> From<(T, SimpleSpan)> for Spanned<T> {
    fn from((item, span): (T, SimpleSpan)) -> Self {
        Self(item, span.into())
    }
}

impl<T> From<(T, Range<usize>)> for Spanned<T> {
    fn from((item, span): (T, Range<usize>)) -> Self {
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

impl Display for Position {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}", self.line, self.column)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AtopileErrorReport {
    span: SimpleSpan,
    reason: String,
    expected: Vec<String>,
    found: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AtopileError {
    Lexer(AtopileErrorReport),
    Parser(AtopileErrorReport),
}

impl<'src, T: Debug + Clone + Display> From<chumsky::error::Rich<'src, T>> for AtopileErrorReport {
    fn from(err: chumsky::error::Rich<'src, T>) -> Self {
        Self {
            span: *err.span(),
            reason: format!("{:?}", err.reason()),
            expected: err.expected().map(|e| e.to_string()).collect(),
            found: err.found().cloned().map(|c| c.to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AtopileSource {
    raw: String,
    path: PathBuf,
    ast: Vec<Spanned<parser::Stmt>>,
    line_to_index: Vec<usize>,
    errors: Vec<AtopileError>,
}

impl AtopileSource {
    pub fn new(raw: String, path: PathBuf) -> Self {
        let mut errors: Vec<AtopileError> = Vec::new();

        let (tokens, lexer_errors) = lex(&raw);
        errors.extend(
            lexer_errors
                .into_iter()
                .map(|e| AtopileError::Lexer(e.into())),
        );

        let (ast, parser_errors) = parser::parse(&tokens);
        errors.extend(
            parser_errors
                .into_iter()
                .map(|e| AtopileError::Parser(e.into())),
        );

        let line_to_index = vec![0]
            .into_iter()
            .chain(
                tokens
                    .iter()
                    .filter(|t| matches!(t.0, lexer::Token::Newline))
                    .map(|t| t.span().end),
            )
            .collect::<Vec<_>>();

        Self {
            raw,
            path,
            ast,
            line_to_index,
            errors,
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

    pub fn errors(&self) -> &Vec<AtopileError> {
        &self.errors
    }
}

type StmtIterWithParent<'a> = (
    std::slice::Iter<'a, Spanned<parser::Stmt>>,
    Option<&'a Spanned<parser::Stmt>>,
);

pub struct StmtTraverser<'a> {
    // Stack of iterators for nested blocks
    stack: Vec<StmtIterWithParent<'a>>,
    // Current path of parent statements leading to current position
    current_path: Vec<&'a Spanned<parser::Stmt>>,
}

impl<'a> StmtTraverser<'a> {
    fn new(stmts: &'a [Spanned<parser::Stmt>]) -> Self {
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
    let source = AtopileSource::new(
        r#"
from "test.ato" import MyModule

from "test2.ato" import MyModule2
    "#
        .trim()
        .to_string(),
        PathBuf::from("test.ato"),
    );

    assert_eq!(source.errors.len(), 0);

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
    let source = AtopileSource::new(
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

    assert_eq!(source.errors.len(), 0);

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
                                Symbol(
                                    "Resistor",
                                ),
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
