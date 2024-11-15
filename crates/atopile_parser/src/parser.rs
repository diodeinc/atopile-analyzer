use chumsky::prelude::*;
use chumsky::{error::Simple, Parser};
use serde::Serialize;

use crate::lexer::Token;
use crate::Spanned;

#[cfg(test)]
use insta::assert_debug_snapshot;

#[derive(Debug, Clone, PartialEq)]
pub enum Stmt {
    Import(ImportStmt),
    DepImport(DepImportStmt),
    Attribute(AttributeStmt),
    Assign(AssignStmt),
    Specialize(SpecializeStmt),
    Connect(ConnectStmt),
    Block(BlockStmt),
    Signal(SignalStmt),
    Pin(PinStmt),
    Assert(AssertStmt),
    Comment(CommentStmt),
    Pass,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImportStmt {
    pub from_path: Spanned<String>,
    pub imports: Vec<Spanned<String>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DepImportStmt {
    pub name: Spanned<String>,
    pub from_path: Spanned<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AttributeStmt {
    pub name: Spanned<String>,
    pub type_info: Spanned<String>,
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
    pub name: Spanned<String>,
    pub parent: Option<Spanned<String>>,
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
    pub name: Spanned<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PinStmt {
    pub name: Spanned<String>,
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
    pub value: Spanned<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    String(Spanned<String>),
    Number(Spanned<String>),
    Port(Spanned<PortRef>),
    New(Spanned<String>),
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

#[derive(Debug, Clone, PartialEq)]
pub struct PhysicalValue {
    pub value: Spanned<String>,
    pub unit: Option<Spanned<String>>,
    pub tolerance: Option<Spanned<Tolerance>>,
}

#[derive(Debug, Clone, PartialEq)]
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

impl ToString for PortRef {
    fn to_string(&self) -> String {
        self.parts
            .iter()
            .map(|p| p.0.as_str())
            .collect::<Vec<&str>>()
            .join(".")
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
        .map_with_span(|name, span| (Expr::New(name), span).into())
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
        Token::Name("kohm".to_string()),
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
        Token::Name("V".to_string()),
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
        .map(|name| Stmt::Signal(SignalStmt { name }))
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
    let tokens = vec![Token::Name("a".to_string())];
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
        Token::Name("a".to_string()),
        Token::Dot,
        Token::Name("b".to_string()),
        Token::Dot,
        Token::Name("c".to_string()),
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
        .map(|(port, value)| Stmt::Specialize(SpecializeStmt { port, value }))
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
                    imports,
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
                    name,
                    from_path: path,
                })
            })
            .map_with_span(|stmt, span| (stmt, span).into());

        // Signal and Pin declarations
        let pin = just(Token::Pin)
            .ignore_then(choice((name(), number(), string())))
            .map(|name| Stmt::Pin(PinStmt { name }))
            .map_with_span(|stmt, span| (stmt, span).into());

        // Attribute statements
        let type_info = || just(Token::Colon).ignore_then(name());
        let attribute = name()
            .then(type_info())
            .map(|(name, type_info)| Stmt::Attribute(AttributeStmt { name, type_info }))
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
                            name,
                            parent,
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
    .labelled("stmt")
}

pub fn parser() -> impl Parser<Token, Vec<Spanned<Stmt>>, Error = Simple<Token>> {
    stmt().repeated().then_ignore(end())
}

pub fn parse(tokens: &Vec<Spanned<Token>>) -> (Vec<Spanned<Stmt>>, Vec<Simple<Token>>) {
    let raw_tokens: Vec<Token> = tokens.iter().map(|t| t.0.clone()).collect();
    parse_raw(raw_tokens)
}

pub fn parse_raw(tokens: Vec<Token>) -> (Vec<Spanned<Stmt>>, Vec<Simple<Token>>) {
    let (ast, errors) = parser().parse_recovery(tokens);
    (ast.unwrap_or_default(), errors)
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
    assert_debug_snapshot!(result, @r###"
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
                                                                1..2,
                                                            ),
                                                        ],
                                                    },
                                                    1..2,
                                                ),
                                            ),
                                            1..2,
                                        ),
                                        op: Spanned(
                                            Within,
                                            2..3,
                                        ),
                                        right: Spanned(
                                            Physical(
                                                Spanned(
                                                    PhysicalValue {
                                                        value: Spanned(
                                                            "10",
                                                            3..4,
                                                        ),
                                                        unit: Some(
                                                            Spanned(
                                                                "kohm",
                                                                4..5,
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
                                                                        6..7,
                                                                    ),
                                                                },
                                                                5..8,
                                                            ),
                                                        ),
                                                    },
                                                    3..8,
                                                ),
                                            ),
                                            3..8,
                                        ),
                                    },
                                    1..8,
                                ),
                            ),
                            1..8,
                        ),
                    },
                ),
                0..8,
            ),
        ],
        [],
    )
    "###);
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
    assert_debug_snapshot!(result, @r###"
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
                                            "10",
                                            1..2,
                                        ),
                                        unit: Some(
                                            Spanned(
                                                "kohm",
                                                2..3,
                                            ),
                                        ),
                                        tolerance: None,
                                    },
                                    1..3,
                                ),
                            ),
                            1..3,
                        ),
                    },
                ),
                0..3,
            ),
        ],
        [],
    )
    "###);
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
    assert_debug_snapshot!(result, @r###"
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
                                        0..1,
                                    ),
                                ],
                            },
                            0..1,
                        ),
                        type_info: None,
                        value: Spanned(
                            New(
                                Spanned(
                                    "Resistor",
                                    3..4,
                                ),
                            ),
                            2..4,
                        ),
                    },
                ),
                0..4,
            ),
        ],
        [],
    )
    "###);
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
    assert_debug_snapshot!(result, @r###"
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
                                        0..1,
                                    ),
                                    Spanned(
                                        "a",
                                        2..3,
                                    ),
                                ],
                            },
                            0..3,
                        ),
                        value: Spanned(
                            "Resistor",
                            4..5,
                        ),
                    },
                ),
                0..5,
            ),
        ],
        [],
    )
    "###);
}
