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
            expected: err.expected().cloned().collect(),
            found: err.found().cloned(),
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
        println!(
            "Creating StmtTraverser with {} top-level statements",
            stmts.len()
        );
        for (i, stmt) in stmts.iter().enumerate() {
            println!("Top-level statement {}: {:?}", i, stmt.0);
            if let parser::Stmt::Block(block) = &stmt.0 {
                println!("  Block has {} body items", block.body.len());
                for (j, body_stmt) in block.body.iter().enumerate() {
                    println!("    Body item {}: {:?}", j, body_stmt.0);
                }
            }
        }

        Self {
            stack: vec![(stmts.iter(), None)],
            current_path: Vec::new(),
        }
    }

    fn get_block_stmts(stmt: &'a Spanned<parser::Stmt>) -> Option<&'a [Spanned<parser::Stmt>]> {
        match &stmt.0 {
            parser::Stmt::Block(block_stmt) => {
                println!("Found block with {} body items", block_stmt.body.len());
                for (i, body_stmt) in block_stmt.body.iter().enumerate() {
                    println!("  Body item {}: {:?}", i, body_stmt.0);
                }
                Some(&block_stmt.body)
            }
            _ => None,
        }
    }
}

impl<'a> Iterator for StmtTraverser<'a> {
    type Item = (&'a Spanned<parser::Stmt>, Vec<&'a Spanned<parser::Stmt>>);

    fn next(&mut self) -> Option<Self::Item> {
        println!("StmtTraverser::next() - Stack size: {}", self.stack.len());

        while let Some((iter, parent)) = self.stack.last_mut() {
            println!("Checking iterator with parent: {:?}", parent.map(|p| &p.0));

            if let Some(stmt) = iter.next() {
                println!("Found statement: {:?}", stmt.0);

                if let Some(parent) = parent {
                    if self.current_path.is_empty() || self.current_path.last() != Some(parent) {
                        println!("Pushing parent to path: {:?}", parent.0);
                        self.current_path.push(parent);
                    }
                }

                let result = (stmt, self.current_path.clone());

                if let parser::Stmt::Block(block_stmt) = &stmt.0 {
                    println!(
                        "Pushing block body with {} items to stack",
                        block_stmt.body.len()
                    );
                    if !block_stmt.body.is_empty() {
                        self.stack.push((block_stmt.body.iter(), Some(stmt)));
                    }
                }

                return Some(result);
            } else {
                println!("Iterator exhausted, popping from stack");
                self.stack.pop();
                if !self.current_path.is_empty() {
                    println!("Popping from path");
                    self.current_path.pop();
                }
            }
        }

        println!("No more statements to traverse");
        None
    }
}

impl<'a> StmtTraverser<'a> {
    fn get_stmt_text(&self, stmt: &Spanned<parser::Stmt>) -> Option<String> {
        match &stmt.0 {
            parser::Stmt::Assign(assign) => {
                if let parser::Expr::New(name) = &assign.value.0 {
                    let target = assign.target.0.parts.first()?.0.clone();
                    let value = name.0.to_string();
                    return Some(format!("{} = new {}", target, value));
                }
            }
            _ => {}
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
        @r#"
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
    "#
    );

    assert_debug_snapshot!(source.stmt_at(48), @r#"
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
                                1..2,
                            ),
                        ),
                        52..64,
                    ),
                },
            ),
            47..64,
        ),
    )
    "#);

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

    println!("AST: {:#?}", source.ast());

    for stmt in source.ast() {
        if let parser::Stmt::Block(block) = &stmt.0 {
            println!(
                "Found block: {:?} with {} body items",
                block.name,
                block.body.len()
            );
            for body_stmt in &block.body {
                println!("  Body item: {:?}", body_stmt.0);
            }
        }
    }

    let mut statements = Vec::new();
    let mut debug_traversal = source.traverse_all_stmts();
    println!("Traversal results:");
    while let Some((stmt, path)) = debug_traversal.next() {
        println!("  Statement: {:?}, Path length: {}", stmt.0, path.len());
        statements.push(stmt);
    }

    println!(
        "Collected {} statements during traversal:",
        statements.len()
    );
    for (i, stmt) in statements.iter().enumerate() {
        println!("  Statement {}: {:?}", i, stmt.0);
    }

    assert_eq!(statements.len(), 5);
}
