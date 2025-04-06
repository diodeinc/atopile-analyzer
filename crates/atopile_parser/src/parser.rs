use std::fmt;
use std::marker::PhantomData;
use std::ops::Deref;

use chumsky::input::{MapExtra, ValueInput};
use chumsky::pratt::{infix, left};
use chumsky::Parser;
use chumsky::{prelude::*, recovery};
use serde::{Deserialize, Serialize};

use crate::lexer::{lex, Token};
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

    // Parse Error
    ParseError,
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
        write!(
            f,
            "{}{} {}",
            self.value.0,
            self.unit
                .as_ref()
                .map(|u| u.0.to_string())
                .unwrap_or("".to_string()),
            self.tolerance
                .as_ref()
                .map(|t| t.to_string())
                .unwrap_or("".to_string())
        )
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

type ParserError<'src> = Rich<'src, Token<'src>, SimpleSpan>;
type ParserExtra<'src> = extra::Err<ParserError<'src>>;

struct AtopileParser<'src, I: ValueInput<'src, Token = Token<'src>, Span = SimpleSpan>> {
    phantom: PhantomData<(&'src (), I)>,
}

impl<'src, I: ValueInput<'src, Token = Token<'src>, Span = SimpleSpan>> AtopileParser<'src, I> {
    fn atom() -> impl Parser<'src, I, Spanned<Expr>, ParserExtra<'src>> + Clone {
        select! {
            Token::String(s) = e => Expr::String((s.to_string(), e.span()).into()),
            Token::Number(n) = e => Expr::Number((n.to_string(), e.span()).into()),
            Token::True = e => Expr::Bool((true, e.span()).into()),
            Token::False = e => Expr::Bool((false, e.span()).into()),
        }
        .or(Self::port_ref().map(|p| Expr::Port(p.clone())))
        .map_with(|expr, e| (expr, e.span()).into())
    }

    fn new() -> impl Parser<'src, I, Spanned<Expr>, ParserExtra<'src>> + Clone {
        just(Token::New)
            .ignore_then(Self::name())
            .map_with(|name, e| (Expr::New(name.map(Symbol::from)), e.span()).into())
    }

    fn physical() -> impl Parser<'src, I, Spanned<Expr>, ParserExtra<'src>> + Clone {
        let signed_number = just(Token::Minus)
            .or_not()
            .then(Self::number())
            .map(|(sign, num)| match sign {
                Some(_) => Spanned(format!("-{}", num.0), num.span().start - 1..num.span().end),
                None => num,
            });

        signed_number
            .then(Self::name().or_not())
            .then(Self::tolerance().or_not())
            .map_with(|((value, unit), tol), e| {
                Expr::Physical(
                    (
                        PhysicalValue {
                            value,
                            unit,
                            tolerance: tol,
                        },
                        e.span(),
                    )
                        .into(),
                )
            })
            .map_with(|expr, e| (expr, e.span()).into())
    }

    fn signal() -> impl Parser<'src, I, Spanned<Stmt>, ParserExtra<'src>> + Clone {
        just(Token::Signal)
            .ignore_then(Self::name())
            .map(|name| {
                Stmt::Signal(SignalStmt {
                    name: name.map(Symbol::from),
                })
            })
            .map_with(|stmt, e| (stmt, e.span()).into())
            .labelled("signal")
    }

    fn port_ref() -> impl Parser<'src, I, Spanned<PortRef>, ParserExtra<'src>> + Clone {
        choice((Self::name(), Self::number()))
            .separated_by(just(Token::Dot))
            .at_least(1)
            .collect()
            .map(|parts| PortRef { parts })
            .map_with(|port_ref, e| (port_ref, e.span()).into())
            .labelled("port_ref")
    }

    fn name() -> impl Parser<'src, I, Spanned<String>, ParserExtra<'src>> + Clone {
        select! { Token::Name(n) = e => (n.to_string(), e.span()).into() }
    }

    fn number() -> impl Parser<'src, I, Spanned<String>, ParserExtra<'src>> + Clone {
        select! { Token::Number(n) = e => (n.to_string(), e.span()).into() }
    }

    fn string() -> impl Parser<'src, I, Spanned<String>, ParserExtra<'src>> + Clone {
        select! { Token::String(s) = e => (s.to_string(), e.span()).into() }
    }

    fn tolerance() -> impl Parser<'src, I, Spanned<Tolerance>, ParserExtra<'src>> + Clone {
        let signed_number = || {
            just(Token::Minus)
                .or_not()
                .then(Self::number())
                .map(|(sign, num)| match sign {
                    Some(_) => Spanned(format!("-{}", num.0), num.span().start - 1..num.span().end),
                    None => num,
                })
        };

        let bilateral = just(Token::PlusOrMinus)
            .ignore_then(signed_number())
            .then(just(Token::Percent).to(None).or(Self::name().map(Some)))
            .map(|(value, unit)| Tolerance::Bilateral { value, unit });

        let bound = just(Token::To)
            .ignore_then(signed_number())
            .then(Self::name().or_not())
            .map(|(max, _unit)| Tolerance::Bound {
                min: ("0".to_string(), 0..0).into(),
                max,
            });

        choice((bilateral, bound)).map_with(|tolerance, e| (tolerance, e.span()).into())
    }

    fn connectable() -> impl Parser<'src, I, Spanned<Connectable>, ParserExtra<'src>> + Clone {
        let name_or_string_or_number = || choice((Self::name(), Self::number(), Self::string()));

        choice((
            just(Token::Pin).ignore_then(name_or_string_or_number().map(Connectable::Pin)),
            Self::port_ref().map(Connectable::Port),
            just(Token::Signal).ignore_then(name_or_string_or_number().map(Connectable::Signal)),
        ))
        .map_with(|connectable, e| (connectable, e.span()).into())
        .labelled("connectable")
    }

    fn comment() -> impl Parser<'src, I, Spanned<Stmt>, ParserExtra<'src>> + Clone {
        select! { Token::Comment(c) = e => (c.to_string(), e.span()).into() }
            .map(|comment| Stmt::Comment(CommentStmt { comment }))
            .map_with(|stmt, e| (stmt, e.span()).into())
            .labelled("comment")
    }

    fn specialize() -> impl Parser<'src, I, Spanned<Stmt>, ParserExtra<'src>> + Clone {
        Self::port_ref()
            .then_ignore(just(Token::Arrow))
            .then(Self::name())
            .map(|(port, value)| {
                Stmt::Specialize(SpecializeStmt {
                    port,
                    value: value.map(Symbol::from),
                })
            })
            .map_with(|stmt, e| (stmt, e.span()).into())
            .labelled("specialize")
    }

    fn expr() -> impl Parser<'src, I, Spanned<Expr>, ParserExtra<'src>> + Clone {
        let op = |tok: Token<'src>, op: BinaryOperator| {
            just(tok).to(op).map_with(|op, e| (op, e.span()).into())
        };

        let pratt_infix = |left: Spanned<Expr>,
                           op: Spanned<BinaryOperator>,
                           right: Spanned<Expr>,
                           e: &mut MapExtra<'src, '_, I, ParserExtra<'src>>|
         -> Spanned<Expr> {
            (
                Expr::BinaryOp(Box::new((BinaryOp { left, op, right }, e.span()).into())),
                e.span(),
            )
                .into()
        };

        // TODO: Fix operator precedence
        let operand = choice((Self::physical(), Self::new(), Self::atom()));
        operand.pratt((
            infix(left(2), op(Token::Star, BinaryOperator::Mul), pratt_infix),
            infix(left(2), op(Token::Plus, BinaryOperator::Add), pratt_infix),
            infix(left(2), op(Token::Minus, BinaryOperator::Sub), pratt_infix),
            infix(left(2), op(Token::Div, BinaryOperator::Div), pratt_infix),
            infix(left(2), op(Token::Eq, BinaryOperator::Eq), pratt_infix),
            infix(left(2), op(Token::Gt, BinaryOperator::Gt), pratt_infix),
            infix(left(2), op(Token::GtEq, BinaryOperator::Gte), pratt_infix),
            infix(left(2), op(Token::Lt, BinaryOperator::Lt), pratt_infix),
            infix(left(2), op(Token::LtEq, BinaryOperator::Lte), pratt_infix),
            infix(
                left(2),
                op(Token::Within, BinaryOperator::Within),
                pratt_infix,
            ),
        ))
    }

    fn top_stmt() -> impl Parser<'src, I, Spanned<Stmt>, ParserExtra<'src>> + Clone {
        let import = just(Token::From)
            .ignore_then(Self::string())
            .then_ignore(just(Token::Import))
            .then(
                Self::name()
                    .separated_by(just(Token::Comma))
                    .collect::<Vec<_>>(),
            )
            .map(|(path, imports)| {
                Stmt::Import(ImportStmt {
                    from_path: path,
                    imports: imports.into_iter().map(|s| s.map(Symbol::from)).collect(),
                })
            })
            .map_with(|stmt, e| (stmt, e.span()).into());

        // Dep import statements (import x from "path")
        let dep_import = just(Token::Import)
            .ignore_then(Self::name())
            .then_ignore(just(Token::From))
            .then(Self::string())
            .map(|(name, path)| {
                Stmt::DepImport(DepImportStmt {
                    name: name.map(Symbol::from),
                    from_path: path,
                })
            })
            .map_with(|stmt, e| (stmt, e.span()).into());

        // Block statements (component/module/interface)
        let block_header = choice((
            just(Token::Component)
                .map(|_| BlockKind::Component)
                .map_with(|kind, e| (kind, e.span()).into()),
            just(Token::Module)
                .map(|_| BlockKind::Module)
                .map_with(|kind, e| (kind, e.span()).into()),
            just(Token::Interface)
                .map(|_| BlockKind::Interface)
                .map_with(|kind, e| (kind, e.span()).into()),
        ))
        .then(Self::name())
        .then(just(Token::From).ignore_then(Self::name()).or_not())
        .then_ignore(just(Token::Colon));

        let block_body = choice((
            // Single line block
            Self::block_stmt()
                .then_ignore(just(Token::Newline))
                .map(|s| vec![s]),
            // Multi-line indented block
            just(Token::Newline)
                .repeated()
                .ignore_then(just(Token::Indent))
                .ignore_then(Self::block_stmt().repeated().collect::<Vec<_>>())
                .then_ignore(just(Token::Dedent)),
        ));

        let block = block_header
            .then(block_body)
            .map_with(|(((kind, name), parent), body), e| {
                (
                    Stmt::Block(BlockStmt {
                        kind,
                        name: name.map(Symbol::from),
                        parent: parent.map(|p| p.map(Symbol::from)),
                        body,
                    }),
                    e.span(),
                )
                    .into()
            });

        // Combine all statement types
        let separator = just(Token::Newline).or(just(Token::Semicolon));
        separator
            .clone()
            .repeated()
            .ignore_then(choice((import, dep_import, block, Self::comment())))
            .then_ignore(separator.repeated())
    }

    fn block_stmt() -> impl Parser<'src, I, Spanned<Stmt>, ParserExtra<'src>> + Clone {
        // Signal and Pin declarations
        let pin = just(Token::Pin)
            .ignore_then(choice((Self::name(), Self::number(), Self::string())))
            .map(|name| {
                Stmt::Pin(PinStmt {
                    name: name.map(Symbol::from),
                })
            })
            .map_with(|stmt, e| (stmt, e.span()).into());

        // Attribute statements
        let type_info = || just(Token::Colon).ignore_then(Self::name());
        let attribute = Self::name()
            .then(type_info())
            .map(|(name, type_info)| {
                Stmt::Attribute(AttributeStmt {
                    name: name.map(Symbol::from),
                    type_info: type_info.map(Symbol::from),
                })
            })
            .map_with(|stmt, e| (stmt, e.span()).into());

        // Assignment statements
        let assign = Self::port_ref()
            .then(type_info().or_not())
            .then_ignore(just(Token::Equals))
            .then(Self::expr())
            .map(|((target, type_info), value)| {
                Stmt::Assign(AssignStmt {
                    target,
                    value,
                    type_info,
                })
            })
            .map_with(|stmt, e| (stmt, e.span()).into());

        // Connection statements
        let connect = Self::connectable()
            .then_ignore(just(Token::Tilde))
            .then(Self::connectable())
            .map(|(left, right)| Stmt::Connect(ConnectStmt { left, right }))
            .map_with(|stmt, e| (stmt, e.span()).into());

        // Pass statement
        let pass = just(Token::Pass)
            .map(|_| Stmt::Pass)
            .map_with(|stmt, e| (stmt, e.span()).into());

        // Assert statement
        let assert = just(Token::Assert)
            .ignore_then(Self::expr())
            .map(|expr| Stmt::Assert(AssertStmt { expr }))
            .map_with(|stmt, e| (stmt, e.span()).into())
            .labelled("assert");

        let recover = just(Token::Newline)
            .not()
            .repeated()
            .then(just(Token::Newline))
            .to(Stmt::ParseError);

        let separator = just(Token::Newline).or(just(Token::Semicolon));
        separator
            .clone()
            .repeated()
            .ignore_then(choice((
                assert,
                Self::specialize(),
                assign,
                attribute,
                connect,
                Self::signal(),
                pin,
                pass,
                Self::comment(),
            )))
            .then_ignore(separator.repeated())
            .recover_with(recovery::via_parser(recover))
    }

    pub fn parser() -> impl Parser<'src, I, Vec<Spanned<Stmt>>, ParserExtra<'src>> {
        Self::top_stmt()
            .repeated()
            .collect::<Vec<_>>()
            .then_ignore(end())
    }
}

pub fn parse<'src>(
    tokens: &'src [Spanned<Token<'src>>],
) -> (Vec<Spanned<Stmt>>, Vec<Rich<'src, Token<'src>>>) {
    let mapped_input = Input::map(tokens, tokens.len()..tokens.len(), |t| (&t.0, &t.1))
        .map_span(|span| span.into());

    let result = AtopileParser::parser().parse(mapped_input);
    (
        result.output().map(|v| v.clone()).unwrap_or(vec![]),
        result.errors().map(|e| e.clone()).collect(),
    )
}

pub fn parse_raw<'src>(
    tokens: &'src [Token<'src>],
) -> (Vec<Spanned<Stmt>>, Vec<Rich<'src, Token<'src>>>) {
    let result = AtopileParser::parser().parse(tokens);
    (
        result.output().map(|v| v.clone()).unwrap_or(vec![]),
        result.errors().map(|e| e.clone()).collect(),
    )
}

#[test]
fn test_physical() {
    let result = AtopileParser::physical().parse(&[
        Token::Number("10"),
        Token::Name("kohm"),
        Token::PlusOrMinus,
        Token::Number("5"),
        Token::Percent,
    ]);

    assert_debug_snapshot!(result, @r###"
    ParseResult {
        output: Some(
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
        errs: [],
    }
    "###);

    // Add a new test case for negative numbers
    let result_negative =
        AtopileParser::physical().parse(&[Token::Minus, Token::Number("0.3"), Token::Name("V")]);
    assert_debug_snapshot!(result_negative, @r###"
    ParseResult {
        output: Some(
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
        errs: [],
    }
    "###);
}

#[test]
fn test_port_ref_simple() {
    let tokens = &[Token::Name("a")];
    let result = AtopileParser::port_ref().parse(tokens);
    assert_debug_snapshot!(result, @r###"
    ParseResult {
        output: Some(
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
        errs: [],
    }
    "###);
}

#[test]
fn test_port_ref_nested() {
    let tokens = &[
        Token::Name("a"),
        Token::Dot,
        Token::Name("b"),
        Token::Dot,
        Token::Name("c"),
    ];
    let result = AtopileParser::port_ref().parse(tokens);
    assert_debug_snapshot!(result, @r###"
    ParseResult {
        output: Some(
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
        errs: [],
    }
    "###);
}

#[test]
fn test_assert_range() {
    let tokens = &[
        Token::Assert,
        Token::Name("a"),
        Token::Within,
        Token::Number("10"),
        Token::Name("kohm"),
        Token::To,
        Token::Number("20"),
        Token::Name("kohm"),
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
    let tokens = &[
        Token::Signal,
        Token::Name("a"),
        Token::Tilde,
        Token::Pin,
        Token::Name("A1"),
    ];

    let result = parse_raw(tokens);
    assert_debug_snapshot!(result, @r###"
    (
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
        [],
    )
    "###);
}

#[test]
fn test_assert() {
    let tokens = &[Token::Assert, Token::Number("10"), Token::Name("kohm")];
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
    let tokens = &[
        Token::Name("r1"),
        Token::Equals,
        Token::New,
        Token::Name("Resistor"),
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
                                    Symbol(
                                        "Resistor",
                                    ),
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
    let tokens = &[
        Token::Name("u1"),
        Token::Dot,
        Token::Name("a"),
        Token::Arrow,
        Token::Name("Resistor"),
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
                            Symbol(
                                "Resistor",
                            ),
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

#[test]
fn test_invalid() {
    let input = r#"
module M:
    pass
    a.b
    pass
    "#;

    let (tokens, _) = lex(input);
    let result = parse(&tokens);
    assert_debug_snapshot!(result, @r###"
    (
        [],
        [Rich { span: 0..1, kind: RichKind::Error, reason: "Unexpected token: !" }],
    )
    "###);
}
