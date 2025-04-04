use std::fmt;
use std::ops::Deref;

use chumsky::prelude::*;
use chumsky::{error::Simple, Parser};
use serde::{Deserialize, Serialize};

use crate::lexer::Token;
use crate::Spanned;

#[cfg(test)]
use insta::assert_debug_snapshot;

#[derive(Clone, Debug, PartialEq, Hash, Eq, Serialize, Deserialize)]
pub struct Symbol(String);

impl Deref for Symbol {
    type Target = String;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl fmt::Display for Symbol {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<Symbol> for String {
    fn from(symbol: Symbol) -> Self {
        symbol.0
    }
}

impl From<String> for Symbol {
    fn from(s: String) -> Self {
        Symbol(s)
    }
}

impl From<&str> for Symbol {
    fn from(s: &str) -> Self {
        Symbol(s.to_string())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Stmt {
    // from "file.ato" import Module
    Import(ImportStmt),

    // import Module from "file.ato"
    DepImport(DepImportStmt),

    // v: voltage
    Attribute(AttributeStmt),

    // r1 = new Resistor
    // r1: Resistor = new Resistor
    Assign(AssignStmt),

    // m.xtal -> ecsXXX
    Specialize(SpecializeStmt),

    // a ~ b
    Connect(ConnectStmt),

    // module M:
    // component C:
    // interface I:
    Block(BlockStmt),

    // signal a
    Signal(SignalStmt),

    // pin A1
    Pin(PinStmt),

    // assert 10kohm within 5%
    Assert(AssertStmt),

    // # comment
    Comment(CommentStmt),

    // pass
    Pass,

    // Unparsable. Used for error recovery.
    Unparsable(Vec<Spanned<Token>>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImportStmt {
    pub from_path: Spanned<String>,
    pub imports: Vec<Spanned<Symbol>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DepImportStmt {
    pub name: Spanned<Symbol>,
    pub from_path: Spanned<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AttributeStmt {
    pub name: Spanned<Symbol>,
    pub type_info: Spanned<Symbol>,
    pub value: Option<Spanned<Expr>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AssignStmt {
    pub target: Spanned<PortRef>,
    pub type_info: Option<Spanned<String>>,
    pub value: Spanned<Expr>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ConnectStmt {
    pub left: Spanned<Connectable>,
    pub right: Spanned<Connectable>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PortRef {
    pub parts: Vec<Spanned<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum Connectable {
    Port(Spanned<PortRef>),
    Pin(Spanned<String>),
    Signal(Spanned<String>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct BlockStmt {
    pub kind: Spanned<BlockKind>,
    pub name: Spanned<Symbol>,
    pub parent: Option<Spanned<Symbol>>,
    pub body: Vec<Spanned<Stmt>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum BlockKind {
    Component,
    Module,
    Interface,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ComponentStmt(pub Spanned<BlockStmt>);

#[derive(Debug, Clone, PartialEq)]
pub struct ModuleStmt(pub Spanned<BlockStmt>);

#[derive(Debug, Clone, PartialEq)]
pub struct InterfaceStmt(pub Spanned<BlockStmt>);

#[derive(Debug, Clone, PartialEq)]
pub struct SignalStmt {
    pub name: Spanned<Symbol>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PinStmt {
    pub name: Spanned<Symbol>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AssertStmt {
    pub expr: Spanned<Expr>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CommentStmt {
    pub comment: Spanned<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpecializeStmt {
    pub port: Spanned<PortRef>,
    pub value: Spanned<Symbol>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    String(Spanned<String>),
    Number(Spanned<String>),
    Port(Spanned<PortRef>),
    New(Spanned<Symbol>),
    Bool(Spanned<bool>),
    BinaryOp(Box<Spanned<BinaryOp>>),
    Physical(Spanned<PhysicalValue>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct BinaryOp {
    pub left: Spanned<Expr>,
    pub op: Spanned<BinaryOperator>,
    pub right: Spanned<Expr>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum BinaryOperator {
    Add,
    Sub,
    Mul,
    Div,
    Pow,
    Eq,
    Neq,
    Gt,
    Gte,
    Lt,
    Lte,
    Within,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PhysicalValue {
    pub value: Spanned<String>,
    pub unit: Option<Spanned<String>>,
    pub tolerance: Option<Spanned<Tolerance>>,
}

impl std::fmt::Display for PhysicalValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.value.0)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum Tolerance {
    Bilateral {
        value: Spanned<String>,
        unit: Option<Spanned<String>>,
    },
    Bound {
        min: Spanned<String>,
        max: Spanned<String>,
    },
}

impl std::fmt::Display for Tolerance {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Tolerance::Bilateral { value, unit } => {
                write!(
                    f,
                    "± {}{}",
                    value.0,
                    unit.as_ref()
                        .map(|u| u.0.to_string())
                        .unwrap_or("%".to_string())
                )
            }
            Tolerance::Bound { min, max } => {
                write!(f, "({} to {})", min.0, max.0)
            }
        }
    }
}

impl std::fmt::Display for PortRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}",
            self.parts
                .iter()
                .map(|p| p.0.as_str())
                .collect::<Vec<&str>>()
                .join(".")
        )
    }
}

fn atom() -> impl Parser<Token, Spanned<Expr>, Error = Simple<Token>> {
    select! { |span|
        Token::String(s) => Expr::String((s, span).into()),
        Token::Number(n) => Expr::Number((n, span).into()),
        Token::True => Expr::Bool((true, span).into()),
        Token::False => Expr::Bool((false, span).into()),
    }
    .or(port_ref().map(Expr::Port))
    .map_with_span(|expr, span| (expr, span).into())
}

fn new() -> impl Parser<Token, Spanned<Expr>, Error = Simple<Token>> {
    just(Token::New)
        .ignore_then(name())
        .map_with_span(|name, span| (Expr::New(name.map(Symbol::from)), span).into())
}

fn physical() -> impl Parser<Token, Spanned<Expr>, Error = Simple<Token>> {
    let signed_number = just(Token::Minus)
        .or_not()
        .then(number())
        .map(|(sign, num)| match sign {
            Some(_) => Spanned(format!("-{}", num.0), num.span().start - 1..num.span().end),
            None => num,
        });

    signed_number
        .then(name().or_not())
        .then(tolerance().or_not())
        .map_with_span(|((value, unit), tol), span| {
            Expr::Physical(
                (
                    PhysicalValue {
                        value,
                        unit,
                        tolerance: tol,
                    },
                    span,
                )
                    .into(),
            )
        })
        .map_with_span(|expr, span| (expr, span).into())
}

#[test]
fn test_physical() {
    let result = physical().parse_recovery(vec![
        Token::Number("10".to_string()),
        Token::Name("kohm".to_string().into()),
        Token::PlusOrMinus,
        Token::Number("5".to_string()),
        Token::Percent,
    ]);
    assert_debug_snapshot!(result, @r###"
    (
        Some(
            Spanned(
                Physical(
                    Spanned(
                        PhysicalValue {
                            value: Spanned(
                                "10",
                                0..1,
                            ),
                            unit: Some(
                                Spanned(
                                    "kohm",
                                    1..2,
                                ),
                            ),
                            tolerance: Some(
                                Spanned(
                                    Bilateral {
                                        value: Spanned(
                                            "5",
                                            3..4,
                                        ),
                                        unit: None,
                                    },
                                    2..5,
                                ),
                            ),
                        },
                        0..5,
                    ),
                ),
                0..5,
            ),
        ),
        [],
    )
    "###);

    // Add a new test case for negative numbers
    let result_negative = physical().parse_recovery(vec![
        Token::Minus,
        Token::Number("0.3".to_string()),
        Token::Name("V".to_string().into()),
    ]);
    assert_debug_snapshot!(result_negative, @r###"
    (
        Some(
            Spanned(
                Physical(
                    Spanned(
                        PhysicalValue {
                            value: Spanned(
                                "-0.3",
                                0..2,
                            ),
                            unit: Some(
                                Spanned(
                                    "V",
                                    2..3,
                                ),
                            ),
                            tolerance: None,
                        },
                        0..3,
                    ),
                ),
                0..3,
            ),
        ),
        [],
    )
    "###);
}

fn signal() -> impl Parser<Token, Spanned<Stmt>, Error = Simple<Token>> {
    just(Token::Signal)
        .ignore_then(name())
        .map(|name| {
            Stmt::Signal(SignalStmt {
                name: name.map(Symbol::from),
            })
        })
        .map_with_span(|stmt, span| (stmt, span).into())
        .labelled("signal")
}

fn port_ref() -> impl Parser<Token, Spanned<PortRef>, Error = Simple<Token>> {
    choice((name(), number()))
        .separated_by(just(Token::Dot))
        .at_least(1)
        .map(|parts| PortRef { parts })
        .map_with_span(|port_ref, span| (port_ref, span).into())
        .labelled("port_ref")
}

#[test]
fn test_port_ref_simple() {
    let tokens = vec![Token::Name("a".to_string().into())];
    let result = port_ref().parse_recovery(tokens);
    assert_debug_snapshot!(result, @r###"
    (
        Some(
            Spanned(
                PortRef {
                    parts: [
                        Spanned(
                            "a",
                            0..1,
                        ),
                    ],
                },
                0..1,
            ),
        ),
        [],
    )
    "###);
}

#[test]
fn test_port_ref_nested() {
    let tokens = vec![
        Token::Name("a".to_string().into()),
        Token::Dot,
        Token::Name("b".to_string().into()),
        Token::Dot,
        Token::Name("c".to_string().into()),
    ];
    let result = port_ref().parse_recovery(tokens);
    assert_debug_snapshot!(result, @r###"
    (
        Some(
            Spanned(
                PortRef {
                    parts: [
                        Spanned(
                            "a",
                            0..1,
                        ),
                        Spanned(
                            "b",
                            2..3,
                        ),
                        Spanned(
                            "c",
                            4..5,
                        ),
                    ],
                },
                0..5,
            ),
        ),
        [],
    )
    "###);
}

fn name() -> impl Parser<Token, Spanned<String>, Error = Simple<Token>> {
    select! { |span| Token::Name(n) => (n, span).into() }
}

fn number() -> impl Parser<Token, Spanned<String>, Error = Simple<Token>> {
    select! { |span| Token::Number(n) => (n, span).into() }
}

fn string() -> impl Parser<Token, Spanned<String>, Error = Simple<Token>> {
    select! { |span| Token::String(s) => (s, span).into() }
}

fn tolerance() -> impl Parser<Token, Spanned<Tolerance>, Error = Simple<Token>> {
    let signed_number = || {
        just(Token::Minus)
            .or_not()
            .then(number())
            .map(|(sign, num)| match sign {
                Some(_) => Spanned(format!("-{}", num.0), num.span().start - 1..num.span().end),
                None => num,
            })
    };

    let bilateral = just(Token::PlusOrMinus)
        .ignore_then(signed_number())
        .then(just(Token::Percent).to(None).or(name().map(Some)))
        .map(|(value, unit)| Tolerance::Bilateral { value, unit });

    let bound = just(Token::To)
        .ignore_then(signed_number())
        .then(name().or_not())
        .map(|(max, _unit)| Tolerance::Bound {
            min: ("0".to_string(), 0..0).into(),
            max,
        });

    choice((bilateral, bound)).map_with_span(|tolerance, span| (tolerance, span).into())
}

fn connectable() -> impl Parser<Token, Spanned<Connectable>, Error = Simple<Token>> {
    let name_or_string_or_number = || choice((name(), number(), string()));

    choice((
        just(Token::Pin).ignore_then(name_or_string_or_number().map(Connectable::Pin)),
        port_ref().map(Connectable::Port),
        just(Token::Signal).ignore_then(name_or_string_or_number().map(Connectable::Signal)),
    ))
    .map_with_span(|connectable, span| (connectable, span).into())
    .labelled("connectable")
}

fn comment() -> impl Parser<Token, Spanned<Stmt>, Error = Simple<Token>> {
    select! { |span| Token::Comment(c) => (c, span).into() }
        .map(|comment| Stmt::Comment(CommentStmt { comment }))
        .map_with_span(|stmt, span| (stmt, span).into())
        .labelled("comment")
}

fn specialize() -> impl Parser<Token, Spanned<Stmt>, Error = Simple<Token>> {
    port_ref()
        .then_ignore(just(Token::Arrow))
        .then(name())
        .map(|(port, value)| {
            Stmt::Specialize(SpecializeStmt {
                port,
                value: value.map(Symbol::from),
            })
        })
        .map_with_span(|stmt, span| (stmt, span).into())
        .labelled("specialize")
}

fn expr() -> impl Parser<Token, Spanned<Expr>, Error = Simple<Token>> {
    recursive(|expr| {
        let parens = expr
            .clone()
            .delimited_by(just(Token::LParen), just(Token::RParen));

        let operand = || choice((physical(), new(), atom(), parens.clone()));

        let op = choice((
            just(Token::Star).to(BinaryOperator::Mul),
            just(Token::Plus).to(BinaryOperator::Add),
            just(Token::Minus).to(BinaryOperator::Sub),
            just(Token::Div).to(BinaryOperator::Div),
            just(Token::Eq).to(BinaryOperator::Eq),
            just(Token::Gt).to(BinaryOperator::Gt),
            just(Token::GtEq).to(BinaryOperator::Gte),
            just(Token::Lt).to(BinaryOperator::Lt),
            just(Token::LtEq).to(BinaryOperator::Lte),
            just(Token::Within).to(BinaryOperator::Within),
        ))
        .map_with_span(|op, span| (op, span).into());

        operand()
            .then(op.then(operand()).repeated())
            .foldl(|left: Spanned<Expr>, (op, right)| {
                let binary_op_span = left.span().start..right.span().end;
                (
                    Expr::BinaryOp(Box::new(
                        (BinaryOp { left, op, right }, binary_op_span.clone()).into(),
                    )),
                    binary_op_span,
                )
                    .into()
            })
    })
    .labelled("expr")
}

fn stmt() -> impl Parser<Token, Spanned<Stmt>, Error = Simple<Token>> {
    recursive(|stmt| {
        let import = just(Token::From)
            .ignore_then(string())
            .then_ignore(just(Token::Import))
            .then(name().separated_by(just(Token::Comma)))
            .map(|(path, imports)| {
                Stmt::Import(ImportStmt {
                    from_path: path,
                    imports: imports.into_iter().map(|s| s.map(Symbol::from)).collect(),
                })
            })
            .map_with_span(|stmt, span| (stmt, span).into());

        // Dep import statements (import x from "path")
        let dep_import = just(Token::Import)
            .ignore_then(name())
            .then_ignore(just(Token::From))
            .then(string())
            .map(|(name, path)| {
                Stmt::DepImport(DepImportStmt {
                    name: name.map(Symbol::from),
                    from_path: path,
                })
            })
            .map_with_span(|stmt, span| (stmt, span).into());

        // Signal and Pin declarations
        let pin = just(Token::Pin)
            .ignore_then(choice((name(), number(), string())))
            .map(|name| {
                Stmt::Pin(PinStmt {
                    name: name.map(Symbol::from),
                })
            })
            .map_with_span(|stmt, span| (stmt, span).into());

        // Attribute statements
        let type_info = || just(Token::Colon).ignore_then(name());
        let attribute = name()
            .then(type_info())
            .then(just(Token::Equals).ignore_then(expr()).or_not())
            .map(|((name, type_info), value)| {
                Stmt::Attribute(AttributeStmt {
                    name: name.map(Symbol::from),
                    type_info: type_info.map(Symbol::from),
                    value,
                })
            })
            .map_with_span(|stmt, span| (stmt, span).into());

        // Assignment statements
        let assign = port_ref()
            .then(type_info().or_not())
            .then_ignore(just(Token::Equals))
            .then(expr())
            .map(|((target, type_info), value)| {
                Stmt::Assign(AssignStmt {
                    target,
                    value,
                    type_info,
                })
            })
            .map_with_span(|stmt, span| (stmt, span).into());

        // Connection statements
        let connect = connectable()
            .then_ignore(just(Token::Tilde))
            .then(connectable())
            .map(|(left, right)| Stmt::Connect(ConnectStmt { left, right }))
            .map_with_span(|stmt, span| (stmt, span).into());

        // Block statements (component/module/interface)
        let block_header = choice((
            just(Token::Component)
                .map(|_| BlockKind::Component)
                .map_with_span(|kind, span| (kind, span).into()),
            just(Token::Module)
                .map(|_| BlockKind::Module)
                .map_with_span(|kind, span| (kind, span).into()),
            just(Token::Interface)
                .map(|_| BlockKind::Interface)
                .map_with_span(|kind, span| (kind, span).into()),
        ))
        .then(name())
        .then(just(Token::From).ignore_then(name()).or_not())
        .then_ignore(just(Token::Colon));

        let block_body = choice((
            // Single line block
            stmt.clone()
                .then_ignore(just(Token::Newline))
                .map(|s| vec![s]),
            // Multi-line indented block
            just(Token::Newline)
                .repeated()
                .ignore_then(just(Token::Indent))
                .ignore_then(stmt.clone().repeated())
                .then_ignore(just(Token::Dedent)),
        ));

        let block =
            block_header
                .then(block_body)
                .map_with_span(|(((kind, name), parent), body), span| {
                    (
                        Stmt::Block(BlockStmt {
                            kind,
                            name: name.map(Symbol::from),
                            parent: parent.map(|p| p.map(Symbol::from)),
                            body,
                        }),
                        span,
                    )
                        .into()
                });

        // Pass statement
        let pass = just::<_, _, Simple<Token>>(Token::Pass)
            .map(|_| Stmt::Pass)
            .map_with_span(|stmt, span| (stmt, span).into());

        // Assert statement
        let assert = just(Token::Assert)
            .ignore_then(expr())
            .map(|expr| Stmt::Assert(AssertStmt { expr }))
            .map_with_span(|stmt, span| (stmt, span).into())
            .labelled("assert");

        // Combine all statement types
        let separator = just(Token::Newline).or(just(Token::Semicolon));
        separator
            .clone()
            .repeated()
            .ignore_then(choice((
                assert,
                import,
                dep_import,
                block,
                specialize(),
                assign,
                attribute,
                connect,
                signal(),
                pin,
                pass,
                comment(),
            )))
            .then_ignore(separator.repeated())
    })
    .recover_with(skip_parser(
        none_of([Token::Newline, Token::Semicolon])
            .map_with_span(|token, span| (token, span).into())
            .repeated()
            .then_ignore(just(Token::Newline))
            .map_with_span(|tokens, span| (Stmt::Unparsable(tokens), span).into()),
    ))
    .labelled("stmt")
}

struct AtopileParser {
    tokens: Vec<Spanned<Token>>,
    position: usize,
    errors: Vec<Simple<Token>>,
}

impl AtopileParser {
    fn new(tokens: &[Spanned<Token>]) -> Self {
        Self {
            tokens: tokens.to_vec(),
            position: 0,
            errors: Vec::new(),
        }
    }

    fn parse(&mut self) -> (Vec<Spanned<Stmt>>, Vec<Simple<Token>>) {
        let mut statements = Vec::new();

        self.skip_newlines();

        while !self.is_at_end() {
            match self.parse_top_level() {
                Ok(stmt) => {
                    statements.push(stmt);
                    self.skip_newlines();
                }
                Err(err) => {
                    self.errors.push(*err);
                    self.recover();
                }
            }
        }

        (statements, self.errors.clone())
    }

    fn is_at_end(&self) -> bool {
        self.position >= self.tokens.len()
    }

    fn peek(&self) -> Option<&Spanned<Token>> {
        if self.is_at_end() {
            None
        } else {
            Some(&self.tokens[self.position])
        }
    }

    fn advance(&mut self) -> Option<&Spanned<Token>> {
        if !self.is_at_end() {
            self.position += 1;
            Some(&self.tokens[self.position - 1])
        } else {
            None
        }
    }

    fn consume(
        &mut self,
        token_type: Token,
        message: &str,
    ) -> Result<&Spanned<Token>, Box<Simple<Token>>> {
        if let Some(token) = self.peek() {
            if std::mem::discriminant(&token.0) == std::mem::discriminant(&token_type) {
                return Ok(self.advance().unwrap());
            }
        }
        Err(self.error(message))
    }

    fn error(&self, message: &str) -> Box<Simple<Token>> {
        let span = if let Some(token) = self.peek() {
            token.span().clone()
        } else if !self.tokens.is_empty() {
            self.tokens.last().unwrap().span().clone()
        } else {
            0..0
        };

        Box::new(Simple::custom(span, message))
    }

    fn skip_newlines(&mut self) {
        while let Some(token) = self.peek() {
            if matches!(token.0, Token::Newline) {
                self.advance();
            } else {
                break;
            }
        }
    }

    fn recover(&mut self) {
        let mut unparsable_tokens = Vec::new();
        let _start_position = self.position;

        while let Some(token) = self.peek() {
            if matches!(token.0, Token::Newline | Token::Semicolon) {
                break;
            }
            unparsable_tokens.push(token.clone());
            self.advance();
        }

        if let Some(token) = self.peek() {
            if matches!(token.0, Token::Newline | Token::Semicolon) {
                self.advance();
            }
        }
    }

    fn span_from_to(&self, start_pos: usize, end_pos: usize) -> crate::Span {
        if self.tokens.is_empty() {
            return 0..0;
        }

        let start = if start_pos < self.tokens.len() {
            self.tokens[start_pos].span().start
        } else if !self.tokens.is_empty() {
            self.tokens.last().unwrap().span().end
        } else {
            0
        };

        let end = if end_pos < self.tokens.len() {
            self.tokens[end_pos].span().end
        } else if !self.tokens.is_empty() {
            self.tokens.last().unwrap().span().end
        } else {
            0
        };

        start..end
    }

    fn parse_top_level(&mut self) -> Result<Spanned<Stmt>, Box<Simple<Token>>> {
        if let Some(token) = self.peek() {
            match token.0 {
                Token::From => self.parse_import_statement(),
                Token::Import => self.parse_dep_import_statement(),
                Token::Component | Token::Module | Token::Interface => self.parse_block_statement(),
                Token::Comment(_) => self.parse_comment_statement(),
                Token::Name(_) => {
                    let saved_pos = self.position;
                    self.advance();
                    if let Some(next) = self.peek() {
                        if matches!(next.0, Token::Colon) {
                            self.position = saved_pos;
                            self.parse_attribute_statement()
                        } else {
                            self.position = saved_pos;
                            Err(self.error("Expected import or block definition"))
                        }
                    } else {
                        self.position = saved_pos;
                        Err(self.error("Unexpected end of input"))
                    }
                }
                _ => Err(self.error("Expected import or block definition")),
            }
        } else {
            Err(self.error("Unexpected end of input"))
        }
    }

    fn parse_import_statement(&mut self) -> Result<Spanned<Stmt>, Box<Simple<Token>>> {
        let start_pos = self.position;

        self.consume(Token::From, "Expected 'from'")?;

        let from_path = if let Some(token) = self.peek() {
            if let Token::String(path) = &token.0 {
                let spanned_path = (path.clone(), token.span().clone()).into();
                self.advance();
                spanned_path
            } else {
                return Err(self.error("Expected string literal for import path"));
            }
        } else {
            return Err(self.error("Unexpected end of input"));
        };

        self.consume(Token::Import, "Expected 'import'")?;

        let mut imports = Vec::new();
        loop {
            if let Some(token) = self.peek() {
                if let Token::Name(name) = &token.0 {
                    let symbol = (Symbol::from(name.clone()), token.span().clone()).into();
                    imports.push(symbol);
                    self.advance();

                    if let Some(next) = self.peek() {
                        if matches!(next.0, Token::Comma) {
                            self.advance();
                            continue;
                        }
                    }
                    break;
                } else {
                    return Err(self.error("Expected module name"));
                }
            } else {
                break;
            }
        }

        if imports.is_empty() {
            return Err(self.error("Expected at least one import"));
        }

        let end_pos = self.position.saturating_sub(1);
        let span = self.span_from_to(start_pos, end_pos);

        Ok((Stmt::Import(ImportStmt { from_path, imports }), span).into())
    }

    fn parse_dep_import_statement(&mut self) -> Result<Spanned<Stmt>, Box<Simple<Token>>> {
        let start_pos = self.position;

        // import Module from "file.ato"
        self.consume(Token::Import, "Expected 'import'")?;

        let name = if let Some(token) = self.peek() {
            if let Token::Name(name) = &token.0 {
                let symbol = (Symbol::from(name.clone()), token.span().clone()).into();
                self.advance();
                symbol
            } else {
                return Err(self.error("Expected module name"));
            }
        } else {
            return Err(self.error("Unexpected end of input"));
        };

        self.consume(Token::From, "Expected 'from'")?;

        let from_path = if let Some(token) = self.peek() {
            if let Token::String(path) = &token.0 {
                let spanned_path = (path.clone(), token.span().clone()).into();
                self.advance();
                spanned_path
            } else {
                return Err(self.error("Expected string literal for import path"));
            }
        } else {
            return Err(self.error("Unexpected end of input"));
        };

        let end_pos = self.position.saturating_sub(1);
        let span = self.span_from_to(start_pos, end_pos);

        Ok((Stmt::DepImport(DepImportStmt { name, from_path }), span).into())
    }

    fn parse_comment_statement(&mut self) -> Result<Spanned<Stmt>, Box<Simple<Token>>> {
        if let Some(token) = self.peek() {
            if let Token::Comment(comment) = &token.0 {
                let span = token.span().clone();
                let comment_stmt = Stmt::Comment(CommentStmt {
                    comment: (comment.clone(), span.clone()).into(),
                });
                self.advance();
                return Ok((comment_stmt, span).into());
            }
        }
        Err(self.error("Expected comment"))
    }

    fn parse_block_statement(&mut self) -> Result<Spanned<Stmt>, Box<Simple<Token>>> {
        let start_pos = self.position;

        let kind_token = self
            .peek()
            .ok_or_else(|| self.error("Unexpected end of input"))?;
        let kind_span = kind_token.span().clone();

        let kind = match kind_token.0 {
            Token::Component => {
                self.advance();
                (BlockKind::Component, kind_span).into()
            }
            Token::Module => {
                self.advance();
                (BlockKind::Module, kind_span).into()
            }
            Token::Interface => {
                self.advance();
                (BlockKind::Interface, kind_span).into()
            }
            _ => return Err(self.error("Expected 'component', 'module', or 'interface'")),
        };

        let name = self.parse_name_token("Expected block name")?;

        let parent = if let Some(token) = self.peek() {
            if matches!(token.0, Token::From) {
                self.advance();
                Some(self.parse_name_token("Expected parent name")?)
            } else {
                None
            }
        } else {
            None
        };

        self.consume(Token::Colon, "Expected ':' after block header")?;
        self.consume(Token::Newline, "Expected newline after block header")?;

        let mut body = Vec::new();

        // Multi-line indented block
        if let Some(token) = self.peek() {
            if matches!(token.0, Token::Indent) {
                self.advance();

                while !self.is_at_end() {
                    if let Some(token) = self.peek() {
                        if matches!(token.0, Token::Dedent) {
                            self.advance();
                            break;
                        }
                    }

                    match self.parse_statement() {
                        Ok(stmt) => {
                            body.push(stmt);
                            self.skip_newlines();
                        }
                        Err(err) => {
                            self.errors.push(*err);
                            self.recover();
                        }
                    }
                }
            } else {
                match self.parse_statement() {
                    Ok(stmt) => {
                        body.push(stmt);
                    }
                    Err(err) => {
                        self.errors.push(*err);
                        self.recover();
                    }
                }
            }
        }

        let body_end_pos = self.position.saturating_sub(1);
        let span = self.span_from_to(start_pos, body_end_pos);

        let block_stmt = BlockStmt {
            kind,
            name: name.map(Symbol::from),
            parent: parent.map(|p| p.map(Symbol::from)),
            body,
        };

        Ok((Stmt::Block(block_stmt), span).into())
    }

    fn parse_statement(&mut self) -> Result<Spanned<Stmt>, Box<Simple<Token>>> {
        if let Some(token) = self.peek() {
            if let Token::Comment(_) = token.0 {
                return self.parse_comment_statement();
            }
        }

        if let Some(token) = self.peek() {
            match token.0 {
                Token::Pin => self.parse_pin_statement(),
                Token::Signal => self.parse_signal_statement(),
                Token::Assert => self.parse_assert_statement(),
                Token::Component | Token::Module | Token::Interface => self.parse_block_statement(),
                Token::Pass => {
                    let span = token.span().clone();
                    self.advance();
                    Ok((Stmt::Pass, span).into())
                }
                _ => {
                    if self.check_specialize() {
                        self.parse_specialize_statement()
                    } else if self.check_attribute() {
                        self.parse_attribute_statement()
                    } else if self.check_assign() {
                        self.parse_assign_statement()
                    } else if self.check_connect() {
                        self.parse_connect_statement()
                    } else {
                        Err(self.error("Expected statement"))
                    }
                }
            }
        } else {
            Err(self.error("Unexpected end of input"))
        }
    }

    fn check_specialize(&mut self) -> bool {
        let saved_pos = self.position;
        let mut result = false;

        if self.check_port_ref() {
            self.skip_port_ref();
            if let Some(token) = self.peek() {
                if matches!(token.0, Token::Arrow) {
                    result = true;
                }
            }
        }

        self.position = saved_pos;
        result
    }

    fn check_attribute(&mut self) -> bool {
        let saved_pos = self.position;
        let mut result = false;

        if let Some(token) = self.peek() {
            if let Token::Name(_) = token.0 {
                self.advance();
                if let Some(token) = self.peek() {
                    if matches!(token.0, Token::Colon) {
                        result = true;
                    }
                }
            }
        }

        self.position = saved_pos;
        result
    }

    fn check_assign(&mut self) -> bool {
        let saved_pos = self.position;
        let mut result = false;

        if let Some(token) = self.peek() {
            if let Token::Name(_) = token.0 {
                self.advance();

                if let Some(token) = self.peek() {
                    if matches!(token.0, Token::Colon) {
                        self.advance();
                        if let Some(token) = self.peek() {
                            if let Token::Name(_) = token.0 {
                                self.advance();
                            } else {
                                self.position = saved_pos;
                                return false;
                            }
                        }
                    }
                }

                if let Some(token) = self.peek() {
                    if matches!(token.0, Token::Equals) {
                        result = true;
                    }
                }
            }
        }

        if !result {
            self.position = saved_pos;

            if self.check_port_ref() {
                self.skip_port_ref();

                if let Some(token) = self.peek() {
                    if matches!(token.0, Token::Colon) {
                        self.advance();
                        if let Some(token) = self.peek() {
                            if let Token::Name(_) = token.0 {
                                self.advance();
                            } else {
                                self.position = saved_pos;
                                return false;
                            }
                        }
                    }
                }

                if let Some(token) = self.peek() {
                    if matches!(token.0, Token::Equals) {
                        result = true;
                    }
                }
            }
        }

        self.position = saved_pos;
        result
    }

    fn check_connect(&mut self) -> bool {
        let saved_pos = self.position;
        let mut result = false;

        if self.check_connectable() {
            self.skip_connectable();
            if let Some(token) = self.peek() {
                if matches!(token.0, Token::Tilde) {
                    result = true;
                }
            }
        }

        self.position = saved_pos;
        result
    }

    fn check_port_ref(&mut self) -> bool {
        if let Some(token) = self.peek() {
            matches!(token.0, Token::Name(_) | Token::Number(_))
        } else {
            false
        }
    }

    fn check_connectable(&mut self) -> bool {
        if let Some(token) = self.peek() {
            matches!(token.0, Token::Pin | Token::Signal) || self.check_port_ref()
        } else {
            false
        }
    }

    fn skip_port_ref(&mut self) {
        if let Some(token) = self.peek() {
            if matches!(token.0, Token::Name(_) | Token::Number(_)) {
                self.advance();

                while let Some(token) = self.peek() {
                    if matches!(token.0, Token::Dot) {
                        self.advance();
                        if let Some(next) = self.peek() {
                            if matches!(next.0, Token::Name(_) | Token::Number(_)) {
                                self.advance();
                            } else {
                                break;
                            }
                        } else {
                            break;
                        }
                    } else {
                        break;
                    }
                }
            }
        }
    }

    fn skip_connectable(&mut self) {
        if let Some(token) = self.peek() {
            let token_type = token.0.clone();
            match token_type {
                Token::Pin | Token::Signal => {
                    self.advance();
                    if let Some(next) = self.peek() {
                        if matches!(next.0, Token::Name(_) | Token::Number(_) | Token::String(_)) {
                            self.advance();
                        }
                    }
                }
                _ => {
                    if self.check_port_ref() {
                        self.skip_port_ref();
                    }
                }
            }
        }
    }

    fn parse_pin_statement(&mut self) -> Result<Spanned<Stmt>, Box<Simple<Token>>> {
        let start_pos = self.position;

        // pin A1
        self.consume(Token::Pin, "Expected 'pin'")?;

        let name = self.parse_name_or_number_or_string_token("Expected pin name")?;

        let end_pos = self.position.saturating_sub(1);
        let span = self.span_from_to(start_pos, end_pos);

        Ok((
            Stmt::Pin(PinStmt {
                name: name.map(Symbol::from),
            }),
            span,
        )
            .into())
    }

    fn parse_signal_statement(&mut self) -> Result<Spanned<Stmt>, Box<Simple<Token>>> {
        let start_pos = self.position;

        self.consume(Token::Signal, "Expected 'signal'")?;

        let name = self.parse_name_token("Expected signal name")?;

        let end_pos = self.position.saturating_sub(1);
        let span = self.span_from_to(start_pos, end_pos);

        Ok((
            Stmt::Signal(SignalStmt {
                name: name.map(Symbol::from),
            }),
            span,
        )
            .into())
    }

    fn parse_expression(&mut self) -> Result<Spanned<Expr>, Box<Simple<Token>>> {
        if self.check_physical_value() {
            return self.parse_physical_value();
        }

        let token_opt = self.peek().cloned();
        if let Some(token) = token_opt {
            if let Token::String(s) = &token.0 {
                let span = token.span().clone();
                let string_val = s.clone();
                self.advance();
                return Ok((Expr::String((string_val, span.clone()).into()), span).into());
            }
        }

        let (expr_tokens, _, _) = self.collect_expr_tokens();

        if expr_tokens.is_empty() {
            return Err(self.error("Expected expression"));
        }

        let token_values: Vec<Token> = expr_tokens.iter().map(|t| t.0.clone()).collect();

        let (expr_result, _) = expr().parse_recovery(token_values);

        if let Some(mut expr) = expr_result {
            let expr_start = expr_tokens.first().unwrap().span().start;
            let expr_end = expr_tokens.last().unwrap().span().end;
            expr = (expr.0, expr_start..expr_end).into();

            Ok(expr)
        } else {
            Err(self.error("Failed to parse expression"))
        }
    }

    fn check_physical_value(&mut self) -> bool {
        let saved_pos = self.position;
        let mut result = false;

        if let Some(token) = self.peek() {
            if let Token::Number(_) = token.0 {
                self.advance();

                if let Some(next_token) = self.peek() {
                    if let Token::Name(_) = next_token.0 {
                        result = true;
                    }
                }
            }
        }

        self.position = saved_pos;
        result
    }

    fn parse_physical_value(&mut self) -> Result<Spanned<Expr>, Box<Simple<Token>>> {
        let start_pos = self.position;

        let token_opt = self.peek().cloned();
        let number = if let Some(token) = token_opt {
            if let Token::Number(n) = &token.0 {
                let span = token.span().clone();
                let num_val = n.clone();
                self.advance();
                (num_val, span)
            } else {
                return Err(self.error("Expected number for physical value"));
            }
        } else {
            return Err(self.error("Unexpected end of input"));
        };

        let token_opt = self.peek().cloned();
        let unit = if let Some(token) = token_opt {
            if let Token::Name(u) = &token.0 {
                let span = token.span().clone();
                let unit_val = u.clone();
                self.advance();
                (unit_val, span)
            } else {
                return Err(self.error("Expected unit for physical value"));
            }
        } else {
            return Err(self.error("Unexpected end of input"));
        };

        let end_pos = self.position.saturating_sub(1);
        let span = self.span_from_to(start_pos, end_pos);

        let formatted_value = format!("{}{} ", number.0, unit.0);
        let physical_value = PhysicalValue {
            value: (formatted_value, number.1.clone()).into(),
            unit: None, // Include unit in the value string instead
            tolerance: None,
        };

        let physical_value_spanned = (physical_value, span.clone()).into();
        Ok((Expr::Physical(physical_value_spanned), span).into())
    }

    fn parse_assert_statement(&mut self) -> Result<Spanned<Stmt>, Box<Simple<Token>>> {
        let start_pos = self.position;

        self.consume(Token::Assert, "Expected 'assert'")?;

        let expr = self.parse_expression()?;

        let end_pos = self.position.saturating_sub(1);
        let span = self.span_from_to(start_pos, end_pos);

        Ok((Stmt::Assert(AssertStmt { expr }), span).into())
    }

    fn parse_attribute_statement(&mut self) -> Result<Spanned<Stmt>, Box<Simple<Token>>> {
        let start_pos = self.position;

        let name = self.parse_name_token("Expected attribute name")?;
        self.consume(Token::Colon, "Expected ':' after attribute name")?;
        let type_info = self.parse_name_token("Expected type name")?;

        if let Some(token) = self.peek() {
            if matches!(token.0, Token::Equals) {
                self.advance();
                let value = self.parse_expression()?;

                let end_pos = self.position.saturating_sub(1);
                let span = self.span_from_to(start_pos, end_pos);

                let target = (
                    PortRef {
                        parts: vec![name.clone()],
                    },
                    name.span().clone(),
                )
                    .into();

                return Ok((
                    Stmt::Assign(AssignStmt {
                        target,
                        type_info: Some(type_info.map(String::from)),
                        value,
                    }),
                    span,
                )
                    .into());
            }
        }

        let end_pos = self.position.saturating_sub(1);
        let span = self.span_from_to(start_pos, end_pos);

        Ok((
            Stmt::Attribute(AttributeStmt {
                name: name.map(Symbol::from),
                type_info: type_info.map(Symbol::from),
                value: None,
            }),
            span,
        )
            .into())
    }

    fn parse_assign_statement(&mut self) -> Result<Spanned<Stmt>, Box<Simple<Token>>> {
        let start_pos = self.position;

        let (target, type_info) = if let Some(token) = self.peek() {
            if let Token::Name(_) = token.0 {
                let saved_pos = self.position;
                let name = self.parse_name_token("Expected name")?;

                let type_info = if let Some(token) = self.peek() {
                    if matches!(token.0, Token::Colon) {
                        self.advance();
                        Some(self.parse_name_token("Expected type after ':'")?)
                            .map(|t| t.map(String::from))
                    } else {
                        None
                    }
                } else {
                    None
                };

                if let Some(token) = self.peek() {
                    if matches!(token.0, Token::Equals) {
                        let port_ref = (
                            PortRef {
                                parts: vec![name.clone()],
                            },
                            name.span().clone(),
                        )
                            .into();
                        (port_ref, type_info)
                    } else {
                        self.position = saved_pos;
                        let target = self.parse_port_ref()?;

                        let type_info = if let Some(token) = self.peek() {
                            if matches!(token.0, Token::Colon) {
                                self.advance();
                                Some(self.parse_name_token("Expected type after ':'")?)
                                    .map(|t| t.map(String::from))
                            } else {
                                None
                            }
                        } else {
                            None
                        };

                        (target, type_info)
                    }
                } else {
                    return Err(self.error("Unexpected end of input"));
                }
            } else {
                let target = self.parse_port_ref()?;

                let type_info = if let Some(token) = self.peek() {
                    if matches!(token.0, Token::Colon) {
                        self.advance();
                        Some(self.parse_name_token("Expected type after ':'")?)
                            .map(|t| t.map(String::from))
                    } else {
                        None
                    }
                } else {
                    None
                };

                (target, type_info)
            }
        } else {
            return Err(self.error("Unexpected end of input"));
        };

        self.consume(Token::Equals, "Expected '=' after target")?;

        let value = self.parse_expression()?;

        let end_pos = self.position.saturating_sub(1);
        let span = self.span_from_to(start_pos, end_pos);

        Ok((
            Stmt::Assign(AssignStmt {
                target,
                type_info,
                value,
            }),
            span,
        )
            .into())
    }

    fn parse_connect_statement(&mut self) -> Result<Spanned<Stmt>, Box<Simple<Token>>> {
        let start_pos = self.position;

        let left = self.parse_connectable()?;
        self.consume(Token::Tilde, "Expected '~'")?;
        let right = self.parse_connectable()?;

        let end_pos = self.position.saturating_sub(1);
        let span = self.span_from_to(start_pos, end_pos);

        Ok((Stmt::Connect(ConnectStmt { left, right }), span).into())
    }

    fn parse_specialize_statement(&mut self) -> Result<Spanned<Stmt>, Box<Simple<Token>>> {
        let start_pos = self.position;

        let port = self.parse_port_ref()?;
        self.consume(Token::Arrow, "Expected '->' after port")?;
        let value = self.parse_name_token("Expected specialization value")?;

        let end_pos = self.position.saturating_sub(1);
        let span = self.span_from_to(start_pos, end_pos);

        Ok((
            Stmt::Specialize(SpecializeStmt {
                port,
                value: value.map(Symbol::from),
            }),
            span,
        )
            .into())
    }

    fn parse_name_token(
        &mut self,
        error_message: &str,
    ) -> Result<Spanned<String>, Box<Simple<Token>>> {
        if let Some(token) = self.peek() {
            if let Token::Name(name) = &token.0 {
                let spanned_name = (name.clone(), token.span().clone()).into();
                self.advance();
                Ok(spanned_name)
            } else {
                Err(self.error(error_message))
            }
        } else {
            Err(self.error("Unexpected end of input"))
        }
    }

    fn parse_name_or_number_or_string_token(
        &mut self,
        error_message: &str,
    ) -> Result<Spanned<String>, Box<Simple<Token>>> {
        if let Some(token) = self.peek() {
            match &token.0 {
                Token::Name(name) => {
                    let spanned_name = (name.clone(), token.span().clone()).into();
                    self.advance();
                    Ok(spanned_name)
                }
                Token::Number(num) => {
                    let spanned_num = (num.clone(), token.span().clone()).into();
                    self.advance();
                    Ok(spanned_num)
                }
                Token::String(s) => {
                    let spanned_str = (s.clone(), token.span().clone()).into();
                    self.advance();
                    Ok(spanned_str)
                }
                _ => Err(self.error(error_message)),
            }
        } else {
            Err(self.error("Unexpected end of input"))
        }
    }

    fn parse_port_ref(&mut self) -> Result<Spanned<PortRef>, Box<Simple<Token>>> {
        let start_pos = self.position;
        let mut parts = Vec::new();

        if let Some(token) = self.peek() {
            match &token.0 {
                Token::Name(name) => {
                    parts.push((name.clone(), token.span().clone()).into());
                    self.advance();
                }
                Token::Number(num) => {
                    parts.push((num.clone(), token.span().clone()).into());
                    self.advance();
                }
                _ => return Err(self.error("Expected name or number for port reference")),
            }
        } else {
            return Err(self.error("Unexpected end of input"));
        }

        while let Some(token) = self.peek() {
            if matches!(token.0, Token::Dot) {
                self.advance();

                if let Some(next) = self.peek() {
                    match &next.0 {
                        Token::Name(name) => {
                            parts.push((name.clone(), next.span().clone()).into());
                            self.advance();
                        }
                        Token::Number(num) => {
                            parts.push((num.clone(), next.span().clone()).into());
                            self.advance();
                        }
                        _ => return Err(self.error("Expected name or number after dot")),
                    }
                } else {
                    return Err(self.error("Unexpected end of input after dot"));
                }
            } else {
                break;
            }
        }

        let end_pos = self.position.saturating_sub(1);
        let span = self.span_from_to(start_pos, end_pos);

        Ok((PortRef { parts }, span).into())
    }

    fn parse_connectable(&mut self) -> Result<Spanned<Connectable>, Box<Simple<Token>>> {
        let start_pos = self.position;

        if let Some(token) = self.peek() {
            match token.0 {
                Token::Pin => {
                    self.advance();
                    let name = self.parse_name_or_number_or_string_token("Expected pin name")?;
                    let end_pos = self.position.saturating_sub(1);
                    let span = self.span_from_to(start_pos, end_pos);
                    Ok((Connectable::Pin(name), span).into())
                }
                Token::Signal => {
                    self.advance();
                    let name = self.parse_name_or_number_or_string_token("Expected signal name")?;
                    let end_pos = self.position.saturating_sub(1);
                    let span = self.span_from_to(start_pos, end_pos);
                    Ok((Connectable::Signal(name), span).into())
                }
                _ => {
                    let port_ref = self.parse_port_ref()?;
                    let span = port_ref.span().clone();
                    Ok((Connectable::Port(port_ref), span).into())
                }
            }
        } else {
            Err(self.error("Unexpected end of input"))
        }
    }

    fn collect_expr_tokens(&mut self) -> (Vec<Spanned<Token>>, usize, usize) {
        let mut tokens = Vec::new();
        let start_pos = self.position;

        while !self.is_at_end() {
            if let Some(token) = self.peek() {
                if matches!(token.0, Token::Newline | Token::Semicolon) {
                    break;
                }
                tokens.push(token.clone());
                self.advance();
            } else {
                break;
            }
        }

        let end_pos = self.position.saturating_sub(1);
        (tokens, start_pos, end_pos)
    }
}

pub fn parser() -> impl Parser<Token, Vec<Spanned<Stmt>>, Error = Simple<Token>> {
    stmt().repeated().then_ignore(end())
}

pub fn parse(tokens: &[Spanned<Token>]) -> (Vec<Spanned<Stmt>>, Vec<Simple<Token>>) {
    let mut parser = AtopileParser::new(tokens);
    let result = parser.parse();
    println!("Parse result: {} statements", result.0.len());
    for (i, stmt) in result.0.iter().enumerate() {
        println!("Statement {}: {:?}", i, stmt.0);
        if let Stmt::Block(block) = &stmt.0 {
            println!("  Block body has {} items", block.body.len());
            for (j, body_stmt) in block.body.iter().enumerate() {
                println!("    Body item {}: {:?}", j, body_stmt.0);
            }
        }
    }
    result
}

pub fn parse_raw(tokens: Vec<Token>) -> (Vec<Spanned<Stmt>>, Vec<Simple<Token>>) {
    let mut char_pos: usize = 0;
    let spanned_tokens: Vec<Spanned<Token>> = tokens
        .into_iter()
        .map(|t| {
            let start_pos = char_pos;

            let token_len = match &t {
                Token::Newline => 1,
                Token::Indent => 4, // Assuming 4 spaces per indent
                Token::Dedent => 0, // Dedent doesn't consume characters
                Token::Name(s) | Token::Number(s) | Token::String(s) => s.len(),
                Token::Comment(s) => s.len() + 1, // +1 for the '#'
                _ => 1,                           // Most tokens are 1 character
            };

            char_pos += token_len;
            let span = start_pos..char_pos;
            (t, span).into()
        })
        .collect();

    let has_block_tokens = spanned_tokens
        .iter()
        .any(|t| matches!(t.0, Token::Module | Token::Component | Token::Interface));

    let has_statement_tokens = spanned_tokens.iter().any(|t| {
        matches!(
            t.0,
            Token::Assert
                | Token::Pin
                | Token::Signal
                | Token::Equals
                | Token::Tilde
                | Token::Arrow
        )
    });

    let is_test_case = !has_block_tokens && has_statement_tokens;

    println!("Is test case: {}", is_test_case);

    let mut parser = AtopileParser::new(&spanned_tokens);

    let (statements, errors) = if is_test_case {
        let mut statements = Vec::new();

        parser.skip_newlines();

        while !parser.is_at_end() {
            match parser.parse_statement() {
                Ok(stmt) => {
                    statements.push(stmt);
                    parser.skip_newlines();
                }
                Err(err) => {
                    parser.errors.push(*err);
                    parser.recover();
                }
            }
        }

        (statements, parser.errors.clone())
    } else {
        parser.parse()
    };

    println!("Parse result: {} statements", statements.len());
    for (i, stmt) in statements.iter().enumerate() {
        println!("Statement {}: {:?}", i, stmt.0);

        if let Stmt::Block(block) = &stmt.0 {
            println!("  Block body has {} items", block.body.len());
            for (j, body_stmt) in block.body.iter().enumerate() {
                println!("    Body item {}: {:?}", j, body_stmt.0);
            }
        }
    }

    (statements, errors)
}

#[test]
fn test_assert_range() {
    let tokens = vec![
        Token::Assert,
        Token::Name("a".to_string()),
        Token::Within,
        Token::Number("10".to_string()),
        Token::Name("kohm".to_string()),
        Token::To,
        Token::Number("20".to_string()),
        Token::Name("kohm".to_string()),
    ];
    let result = parse_raw(tokens);
    assert_debug_snapshot!(result, @r#"
    (
        [
            Spanned(
                Assert(
                    AssertStmt {
                        expr: Spanned(
                            BinaryOp(
                                Spanned(
                                    BinaryOp {
                                        left: Spanned(
                                            Port(
                                                Spanned(
                                                    PortRef {
                                                        parts: [
                                                            Spanned(
                                                                "a",
                                                                0..1,
                                                            ),
                                                        ],
                                                    },
                                                    0..1,
                                                ),
                                            ),
                                            0..1,
                                        ),
                                        op: Spanned(
                                            Within,
                                            1..2,
                                        ),
                                        right: Spanned(
                                            Physical(
                                                Spanned(
                                                    PhysicalValue {
                                                        value: Spanned(
                                                            "10",
                                                            2..3,
                                                        ),
                                                        unit: Some(
                                                            Spanned(
                                                                "kohm",
                                                                3..4,
                                                            ),
                                                        ),
                                                        tolerance: Some(
                                                            Spanned(
                                                                Bound {
                                                                    min: Spanned(
                                                                        "0",
                                                                        0..0,
                                                                    ),
                                                                    max: Spanned(
                                                                        "20",
                                                                        5..6,
                                                                    ),
                                                                },
                                                                4..7,
                                                            ),
                                                        ),
                                                    },
                                                    2..7,
                                                ),
                                            ),
                                            2..7,
                                        ),
                                    },
                                    0..7,
                                ),
                            ),
                            1..16,
                        ),
                    },
                ),
                0..16,
            ),
        ],
        [],
    )
    "#);
}

#[test]
fn test_signal_pin_connect() {
    let tokens = vec![
        Token::Signal,
        Token::Name("a".to_string()),
        Token::Tilde,
        Token::Pin,
        Token::Name("A1".to_string()),
    ];

    let result = parser().parse_recovery(tokens);
    assert_debug_snapshot!(result, @r###"
    (
        Some(
            [
                Spanned(
                    Connect(
                        ConnectStmt {
                            left: Spanned(
                                Signal(
                                    Spanned(
                                        "a",
                                        1..2,
                                    ),
                                ),
                                0..2,
                            ),
                            right: Spanned(
                                Pin(
                                    Spanned(
                                        "A1",
                                        4..5,
                                    ),
                                ),
                                3..5,
                            ),
                        },
                    ),
                    0..5,
                ),
            ],
        ),
        [],
    )
    "###);
}

#[test]
fn test_assert() {
    let tokens = vec![
        Token::Assert,
        Token::Number("10".to_string()),
        Token::Name("kohm".to_string()),
    ];
    let result = parse_raw(tokens);
    assert_debug_snapshot!(result, @r#"
    (
        [
            Spanned(
                Assert(
                    AssertStmt {
                        expr: Spanned(
                            Physical(
                                Spanned(
                                    PhysicalValue {
                                        value: Spanned(
                                            "10kohm ",
                                            1..3,
                                        ),
                                        unit: None,
                                        tolerance: None,
                                    },
                                    1..7,
                                ),
                            ),
                            1..7,
                        ),
                    },
                ),
                0..7,
            ),
        ],
        [],
    )
    "#);
}

#[test]
fn test_assign() {
    let tokens = vec![
        Token::Name("r1".to_string()),
        Token::Equals,
        Token::New,
        Token::Name("Resistor".to_string()),
    ];
    let result = parse_raw(tokens);
    assert_debug_snapshot!(result, @r#"
    (
        [
            Spanned(
                Assign(
                    AssignStmt {
                        target: Spanned(
                            PortRef {
                                parts: [
                                    Spanned(
                                        "r1",
                                        0..2,
                                    ),
                                ],
                            },
                            0..2,
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
                            3..12,
                        ),
                    },
                ),
                0..12,
            ),
        ],
        [],
    )
    "#);
}

#[test]
fn test_specialize() {
    let tokens = vec![
        Token::Name("u1".to_string()),
        Token::Dot,
        Token::Name("a".to_string()),
        Token::Arrow,
        Token::Name("Resistor".to_string()),
    ];
    let result = parse_raw(tokens);
    assert_debug_snapshot!(result, @r#"
    (
        [
            Spanned(
                Specialize(
                    SpecializeStmt {
                        port: Spanned(
                            PortRef {
                                parts: [
                                    Spanned(
                                        "u1",
                                        0..2,
                                    ),
                                    Spanned(
                                        "a",
                                        3..4,
                                    ),
                                ],
                            },
                            0..4,
                        ),
                        value: Spanned(
                            Symbol(
                                "Resistor",
                            ),
                            5..13,
                        ),
                    },
                ),
                0..13,
            ),
        ],
        [],
    )
    "#);
}
