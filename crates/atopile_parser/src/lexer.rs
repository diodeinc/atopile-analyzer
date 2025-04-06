use crate::Spanned;
use chumsky::prelude::*;
use std::{fmt, marker::PhantomData};

#[cfg(test)]
use insta::assert_debug_snapshot;

#[derive(Clone, Debug, PartialEq, Hash, Eq)]
pub enum Token<'src> {
    // Keywords
    Component,
    Module,
    Interface,
    Pin,
    Signal,
    New,
    From,
    Import,
    Assert,
    To,
    Within,
    Pass,

    // Literals
    String(&'src str),
    Number(&'src str),
    Name(&'src str),
    True,
    False,

    // Operators
    PlusOrMinus, // +/- or ±
    Percent,     // %
    Dot,         // .
    Star,        // *
    Plus,        // +
    Minus,       // -
    Div,         // /
    Tilde,       // ~
    Arrow,       // ->

    // Delimiters
    LParen,    // (
    RParen,    // )
    LBrack,    // [
    RBrack,    // ]
    LBrace,    // {
    RBrace,    // }
    Colon,     // :
    Semicolon, // ;
    Comma,     // ,

    // Assignments
    Equals,      // =
    PlusEquals,  // +=
    MinusEquals, // -=
    OrEquals,    // |=
    AndEquals,   // &=

    // Comparisons
    Eq,   // ==
    Lt,   // <
    Gt,   // >
    LtEq, // <=
    GtEq, // >=

    // Comments
    Comment(&'src str),
    MultiCommentStart, // """
    MultiCommentEnd,   // """

    // Indentation
    Indent,
    Dedent,
    Newline,
}

impl<'src> fmt::Display for Token<'src> {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Token::Component => write!(f, "component"),
            Token::Module => write!(f, "module"),
            Token::Interface => write!(f, "interface"),
            Token::Pin => write!(f, "pin"),
            Token::Signal => write!(f, "signal"),
            Token::New => write!(f, "new"),
            Token::From => write!(f, "from"),
            Token::Import => write!(f, "import"),
            Token::Assert => write!(f, "assert"),
            Token::To => write!(f, "to"),
            Token::Within => write!(f, "within"),
            Token::Pass => write!(f, "pass"),
            Token::String(s) => write!(f, "\"{}\"", s),
            Token::Number(n) => write!(f, "{}", n),
            Token::Name(n) => write!(f, "{}", n),
            Token::True => write!(f, "True"),
            Token::False => write!(f, "False"),
            Token::PlusOrMinus => write!(f, "+/-"),
            Token::Arrow => write!(f, "->"),
            Token::Percent => write!(f, "%"),
            Token::Dot => write!(f, "."),
            Token::Star => write!(f, "*"),
            Token::Plus => write!(f, "+"),
            Token::Minus => write!(f, "-"),
            Token::Div => write!(f, "/"),
            Token::Tilde => write!(f, "~"),
            Token::LParen => write!(f, "("),
            Token::RParen => write!(f, ")"),
            Token::LBrack => write!(f, "["),
            Token::RBrack => write!(f, "]"),
            Token::LBrace => write!(f, "{{"),
            Token::RBrace => write!(f, "}}"),
            Token::Colon => write!(f, ":"),
            Token::Semicolon => write!(f, ";"),
            Token::Comma => write!(f, ","),
            Token::Equals => write!(f, "="),
            Token::PlusEquals => write!(f, "+="),
            Token::MinusEquals => write!(f, "-="),
            Token::OrEquals => write!(f, "|="),
            Token::AndEquals => write!(f, "&="),
            Token::Eq => write!(f, "=="),
            Token::Lt => write!(f, "<"),
            Token::Gt => write!(f, ">"),
            Token::LtEq => write!(f, "<="),
            Token::GtEq => write!(f, ">="),
            Token::Indent => write!(f, "<indent>"),
            Token::Dedent => write!(f, "<dedent>"),
            Token::Newline => write!(f, "<newline>"),
            Token::Comment(c) => write!(f, "<comment: \"{}\">", c),
            Token::MultiCommentStart => write!(f, "<multi-line comment start>"),
            Token::MultiCommentEnd => write!(f, "<multi-line comment end>"),
        }
    }
}

type LexerError<'src> = Rich<'src, char, SimpleSpan>;
type LexerExtra<'src> = extra::Err<LexerError<'src>>;

pub struct Lexer<'src> {
    phantom: PhantomData<&'src ()>,
}

impl<'src> Lexer<'src> {
    fn keyword() -> impl Parser<'src, &'src str, Token<'src>, LexerExtra<'src>> {
        choice([
            text::keyword("component").to(Token::Component),
            text::keyword("module").to(Token::Module),
            text::keyword("interface").to(Token::Interface),
            text::keyword("pin").to(Token::Pin),
            text::keyword("signal").to(Token::Signal),
            text::keyword("new").to(Token::New),
            text::keyword("from").to(Token::From),
            text::keyword("import").to(Token::Import),
            text::keyword("assert").to(Token::Assert),
            text::keyword("to").to(Token::To),
            text::keyword("within").to(Token::Within),
            text::keyword("pass").to(Token::Pass),
            text::keyword("True").to(Token::True),
            text::keyword("False").to(Token::False),
        ])
    }

    fn name() -> impl Parser<'src, &'src str, Token<'src>, LexerExtra<'src>> {
        text::ident().map(Token::Name)
    }

    fn number() -> impl Parser<'src, &'src str, Token<'src>, LexerExtra<'src>> {
        text::int(10)
            .then(just('.').then(text::digits(10)).or_not())
            .to_slice()
            .map(Token::Number)
    }

    fn string() -> impl Parser<'src, &'src str, Token<'src>, LexerExtra<'src>> {
        just('"')
            .ignore_then(none_of("\"").repeated().to_slice())
            .then_ignore(just('"'))
            .map(Token::String)
    }

    fn symbol() -> impl Parser<'src, &'src str, Token<'src>, LexerExtra<'src>> {
        choice([
            just("+/-").to(Token::PlusOrMinus),
            just("±").to(Token::PlusOrMinus),
            just("->").to(Token::Arrow),
            just("%").to(Token::Percent),
            just(".").to(Token::Dot),
            just("*").to(Token::Star),
            just("+").to(Token::Plus),
            just("-").to(Token::Minus),
            just("/").to(Token::Div),
            just("~").to(Token::Tilde),
            just("(").to(Token::LParen),
            just(")").to(Token::RParen),
            just("[").to(Token::LBrack),
            just("]").to(Token::RBrack),
            just("{").to(Token::LBrace),
            just("}").to(Token::RBrace),
            just(":").to(Token::Colon),
            just(";").to(Token::Semicolon),
            just(",").to(Token::Comma),
            just("+=").to(Token::PlusEquals),
            just("-=").to(Token::MinusEquals),
            just("|=").to(Token::OrEquals),
            just("&=").to(Token::AndEquals),
            just("==").to(Token::Eq),
            just("=").to(Token::Equals),
            just("<=").to(Token::LtEq),
            just(">=").to(Token::GtEq),
            just("<").to(Token::Lt),
            just(">").to(Token::Gt),
        ])
    }

    fn single_comment() -> impl Parser<'src, &'src str, Token<'src>, LexerExtra<'src>> {
        just('#')
            .ignore_then(none_of("\n").repeated().to_slice())
            .map(Token::Comment)
    }

    fn multi_comment() -> impl Parser<'src, &'src str, Token<'src>, LexerExtra<'src>> {
        just("\"\"\"")
            .ignore_then(any().and_is(just("\"\"\"").not()).repeated().to_slice())
            .then_ignore(just("\"\"\""))
            .map(Token::Comment)
    }

    fn token() -> impl Parser<'src, &'src str, Spanned<Token<'src>>, LexerExtra<'src>> {
        choice((
            Self::multi_comment(),
            Self::single_comment(),
            Self::keyword(),
            Self::name(),
            Self::number(),
            Self::string(),
            Self::symbol(),
        ))
        .map_with(|tok, e| (tok, e.span()).into())
        .padded()
    }

    fn line_parser() -> impl Parser<'src, &'src str, Vec<Spanned<&'src str>>, LexerExtra<'src>> {
        let line_content = none_of("\n").repeated().to_slice();
        let line = line_content.map_with(|content, e| (content, e.span()).into());
        line.separated_by(just('\n'))
            .allow_trailing()
            .collect::<Vec<_>>()
    }

    pub fn lex(input: &'src str) -> (Vec<Spanned<Token<'src>>>, Vec<LexerError<'src>>) {
        let mut tokens = Vec::new();
        let mut errors = Vec::new();
        let mut in_multiline_comment = false;

        // Handle empty input
        if input.is_empty() {
            return (tokens, errors);
        }

        // Parse the input into lines with spans
        let result = Self::line_parser().parse(input);
        errors.extend(result.errors().map(|e| e.clone()));

        let mut indent_stack = vec![0];

        // Process each line
        for (line, line_span) in result
            .output()
            .unwrap_or(&vec![])
            .into_iter()
            .map(|l| (l.0, l.1.clone()))
        {
            let indent_level = line.chars().take_while(|c| c.is_whitespace()).count();

            if !line.trim().is_empty() {
                // Handle indentation (if we aren't in a multi-line comment)
                if !in_multiline_comment {
                    while indent_level < *indent_stack.last().unwrap() {
                        indent_stack.pop();
                        tokens.push((Token::Dedent, (line_span.start..line_span.start)).into());
                    }

                    if indent_level > *indent_stack.last().unwrap() {
                        indent_stack.push(indent_level);
                        tokens.push((Token::Indent, (line_span.start..line_span.start)).into());
                    }
                }

                let mut line_pos = 0;
                let trimmed_line = line.trim();
                let content_offset = line_span.start + (line.len() - trimmed_line.len());

                // Most of the logic below is to deal with multi-line comments. For
                // now, we don't disambiguate between multi-line comments and
                // regular comments in the final lexer output, as we depend on
                // Newline tokens to match the line count. Instead, a multi-line
                // comment will emit a separate Comment token for each line.
                while line_pos < trimmed_line.len() {
                    if in_multiline_comment {
                        if let Some(end_pos) = trimmed_line[line_pos..].find("\"\"\"") {
                            // Add comment content before the end marker
                            let comment = trimmed_line[line_pos..line_pos + end_pos].trim();
                            if !comment.is_empty() {
                                tokens.push(
                                    (
                                        Token::Comment(comment),
                                        (content_offset + line_pos
                                            ..content_offset + line_pos + end_pos),
                                    )
                                        .into(),
                                );
                            }

                            // Add end marker
                            tokens.push(
                                (
                                    Token::MultiCommentEnd,
                                    (content_offset + line_pos + end_pos
                                        ..content_offset + line_pos + end_pos + 3),
                                )
                                    .into(),
                            );

                            line_pos += end_pos + 3;
                            in_multiline_comment = false;
                        } else {
                            // Add whole remaining line as comment
                            tokens.push(
                                (
                                    Token::Comment(&trimmed_line[line_pos..]),
                                    (content_offset + line_pos..line_span.end),
                                )
                                    .into(),
                            );
                            break;
                        }
                    } else {
                        // Look for start of multi-line comment
                        if let Some(start_pos) = trimmed_line[line_pos..].find("\"\"\"") {
                            // Process tokens before comment if any
                            if start_pos > 0 {
                                let before_comment = &trimmed_line[line_pos..line_pos + start_pos];
                                let result = Self::token()
                                    .repeated()
                                    .collect::<Vec<_>>()
                                    .parse(before_comment);
                                errors.extend(result.errors().map(|e| e.clone()));

                                if let Some(toks) = result.output() {
                                    for (tok, tok_span) in
                                        toks.iter().map(|t| (t.0.clone(), t.1.clone()))
                                    {
                                        tokens.push(
                                            (
                                                tok,
                                                (tok_span.start + content_offset + line_pos
                                                    ..tok_span.end + content_offset + line_pos),
                                            )
                                                .into(),
                                        );
                                    }
                                }
                            }

                            // Add start marker
                            tokens.push(
                                (
                                    Token::MultiCommentStart,
                                    (content_offset + line_pos + start_pos
                                        ..content_offset + line_pos + start_pos + 3),
                                )
                                    .into(),
                            );

                            line_pos += start_pos + 3;
                            in_multiline_comment = true;

                            // Check if comment ends on same line
                            if let Some(end_pos) = trimmed_line[line_pos..].find("\"\"\"") {
                                // Add comment content if any
                                let comment = trimmed_line[line_pos..line_pos + end_pos].trim();
                                if !comment.is_empty() {
                                    tokens.push(
                                        (
                                            Token::Comment(comment),
                                            (content_offset + line_pos
                                                ..content_offset + line_pos + end_pos),
                                        )
                                            .into(),
                                    );
                                }

                                // Add end marker
                                tokens.push(
                                    (
                                        Token::MultiCommentEnd,
                                        (content_offset + line_pos + end_pos
                                            ..content_offset + line_pos + end_pos + 3),
                                    )
                                        .into(),
                                );

                                line_pos += end_pos + 3;
                                in_multiline_comment = false;
                            }
                        } else {
                            // Process regular tokens
                            let result = Self::token()
                                .repeated()
                                .collect::<Vec<_>>()
                                .parse(&trimmed_line[line_pos..]);
                            errors.extend(result.errors().map(|e| e.clone()));

                            if let Some(toks) = result.output() {
                                for (tok, tok_span) in
                                    toks.iter().map(|t| (t.0.clone(), t.1.clone()))
                                {
                                    tokens.push(
                                        (
                                            tok,
                                            (tok_span.start + content_offset + line_pos
                                                ..tok_span.end + content_offset + line_pos),
                                        )
                                            .into(),
                                    );
                                }
                            }
                            break;
                        }
                    }
                }
            }

            // Add newline token
            if line_span.end < input.len() {
                if line.is_empty() {
                    tokens.push((Token::Newline, (line_span.start..line_span.start + 1)).into());
                } else {
                    tokens.push((Token::Newline, (line_span.end..line_span.end + 1)).into());
                }
            }
        }

        // Handle any remaining dedents
        while indent_stack.len() > 1 {
            indent_stack.pop();
            tokens.push((Token::Dedent, (input.len()..input.len())).into());
        }

        let tokens = tokens
            .into_iter()
            .filter(|t| !matches!(t.0, Token::MultiCommentStart | Token::MultiCommentEnd))
            .collect::<Vec<_>>();

        (tokens, errors)
    }
}

#[test]
fn test_keyword_in_token() {
    let input = "top";
    let output = Lexer::lex(input);
    assert_debug_snapshot!(output, @r###"
    (
        [
            Spanned(
                Name(
                    "top",
                ),
                0..3,
            ),
        ],
        [],
    )
    "###);
}

#[test]
fn test_bool() {
    let input = "a = True";
    let output = Lexer::lex(input);
    assert_debug_snapshot!(output, @r###"
    (
        [
            Spanned(
                Name(
                    "a",
                ),
                0..1,
            ),
            Spanned(
                Equals,
                2..3,
            ),
            Spanned(
                True,
                4..8,
            ),
        ],
        [],
    )
    "###);
}

#[test]
fn test_simple() {
    let (tokens, errors) = Lexer::lex(
        r#"
from "my/file.ato" import MyComponentA, MyComponentB
from "my/other/file.ato" import MyOtherComponentA, MyOtherComponentB
"#,
    );

    assert_debug_snapshot!(errors, @r###"
    []
    "###);

    assert_debug_snapshot!(tokens, @r###"
    [
        Spanned(
            Newline,
            0..1,
        ),
        Spanned(
            From,
            1..5,
        ),
        Spanned(
            String(
                "my/file.ato",
            ),
            6..19,
        ),
        Spanned(
            Import,
            20..26,
        ),
        Spanned(
            Name(
                "MyComponentA",
            ),
            27..39,
        ),
        Spanned(
            Comma,
            39..40,
        ),
        Spanned(
            Name(
                "MyComponentB",
            ),
            41..53,
        ),
        Spanned(
            Newline,
            53..54,
        ),
        Spanned(
            From,
            54..58,
        ),
        Spanned(
            String(
                "my/other/file.ato",
            ),
            59..78,
        ),
        Spanned(
            Import,
            79..85,
        ),
        Spanned(
            Name(
                "MyOtherComponentA",
            ),
            86..103,
        ),
        Spanned(
            Comma,
            103..104,
        ),
        Spanned(
            Name(
                "MyOtherComponentB",
            ),
            105..122,
        ),
        Spanned(
            Newline,
            122..123,
        ),
    ]
    "###);
}

#[test]
fn test_indent() {
    let (tokens, errors) = Lexer::lex(
        r#"

    component Test:

        signal a

        signal b
        signal c

        signal d
    "#,
    );

    assert_debug_snapshot!(errors, @r###"
    []
    "###);

    assert_debug_snapshot!(tokens, @r###"
    [
        Spanned(
            Newline,
            0..1,
        ),
        Spanned(
            Newline,
            1..2,
        ),
        Spanned(
            Indent,
            2..2,
        ),
        Spanned(
            Component,
            6..15,
        ),
        Spanned(
            Name(
                "Test",
            ),
            16..20,
        ),
        Spanned(
            Colon,
            20..21,
        ),
        Spanned(
            Newline,
            21..22,
        ),
        Spanned(
            Newline,
            22..23,
        ),
        Spanned(
            Indent,
            23..23,
        ),
        Spanned(
            Signal,
            31..37,
        ),
        Spanned(
            Name(
                "a",
            ),
            38..39,
        ),
        Spanned(
            Newline,
            39..40,
        ),
        Spanned(
            Newline,
            40..41,
        ),
        Spanned(
            Signal,
            49..55,
        ),
        Spanned(
            Name(
                "b",
            ),
            56..57,
        ),
        Spanned(
            Newline,
            57..58,
        ),
        Spanned(
            Signal,
            66..72,
        ),
        Spanned(
            Name(
                "c",
            ),
            73..74,
        ),
        Spanned(
            Newline,
            74..75,
        ),
        Spanned(
            Newline,
            75..76,
        ),
        Spanned(
            Signal,
            84..90,
        ),
        Spanned(
            Name(
                "d",
            ),
            91..92,
        ),
        Spanned(
            Newline,
            92..93,
        ),
        Spanned(
            Dedent,
            97..97,
        ),
        Spanned(
            Dedent,
            97..97,
        ),
    ]
    "###);
}

#[test]
fn test_lexer() {
    let (tokens, errors) = Lexer::lex(
        r#"
from "my/file.ato" import MyComponentA, MyComponentB

component Test:
    signal a ~ pin "1A"
    signal b

module TestModule from Test:
    a.b.c ~ b
    assert x >= 3 < 5

    r1 = new Resistor
    r1.value = 10kohm +/- 5%
    r1.mpn = "MPN123"

    assert r1.value within 10kohm +/- 5%

interface TestInterface:
    signal a
    "#,
    );

    assert_debug_snapshot!(errors, @r###"
    []
    "###);

    assert_debug_snapshot!(tokens, @r###"
    [
        Spanned(
            Newline,
            0..1,
        ),
        Spanned(
            From,
            1..5,
        ),
        Spanned(
            String(
                "my/file.ato",
            ),
            6..19,
        ),
        Spanned(
            Import,
            20..26,
        ),
        Spanned(
            Name(
                "MyComponentA",
            ),
            27..39,
        ),
        Spanned(
            Comma,
            39..40,
        ),
        Spanned(
            Name(
                "MyComponentB",
            ),
            41..53,
        ),
        Spanned(
            Newline,
            53..54,
        ),
        Spanned(
            Newline,
            54..55,
        ),
        Spanned(
            Component,
            55..64,
        ),
        Spanned(
            Name(
                "Test",
            ),
            65..69,
        ),
        Spanned(
            Colon,
            69..70,
        ),
        Spanned(
            Newline,
            70..71,
        ),
        Spanned(
            Indent,
            71..71,
        ),
        Spanned(
            Signal,
            75..81,
        ),
        Spanned(
            Name(
                "a",
            ),
            82..83,
        ),
        Spanned(
            Tilde,
            84..85,
        ),
        Spanned(
            Pin,
            86..89,
        ),
        Spanned(
            String(
                "1A",
            ),
            90..94,
        ),
        Spanned(
            Newline,
            94..95,
        ),
        Spanned(
            Signal,
            99..105,
        ),
        Spanned(
            Name(
                "b",
            ),
            106..107,
        ),
        Spanned(
            Newline,
            107..108,
        ),
        Spanned(
            Newline,
            108..109,
        ),
        Spanned(
            Dedent,
            109..109,
        ),
        Spanned(
            Module,
            109..115,
        ),
        Spanned(
            Name(
                "TestModule",
            ),
            116..126,
        ),
        Spanned(
            From,
            127..131,
        ),
        Spanned(
            Name(
                "Test",
            ),
            132..136,
        ),
        Spanned(
            Colon,
            136..137,
        ),
        Spanned(
            Newline,
            137..138,
        ),
        Spanned(
            Indent,
            138..138,
        ),
        Spanned(
            Name(
                "a",
            ),
            142..143,
        ),
        Spanned(
            Dot,
            143..144,
        ),
        Spanned(
            Name(
                "b",
            ),
            144..145,
        ),
        Spanned(
            Dot,
            145..146,
        ),
        Spanned(
            Name(
                "c",
            ),
            146..147,
        ),
        Spanned(
            Tilde,
            148..149,
        ),
        Spanned(
            Name(
                "b",
            ),
            150..151,
        ),
        Spanned(
            Newline,
            151..152,
        ),
        Spanned(
            Assert,
            156..162,
        ),
        Spanned(
            Name(
                "x",
            ),
            163..164,
        ),
        Spanned(
            GtEq,
            165..167,
        ),
        Spanned(
            Number(
                "3",
            ),
            168..169,
        ),
        Spanned(
            Lt,
            170..171,
        ),
        Spanned(
            Number(
                "5",
            ),
            172..173,
        ),
        Spanned(
            Newline,
            173..174,
        ),
        Spanned(
            Newline,
            174..175,
        ),
        Spanned(
            Name(
                "r1",
            ),
            179..181,
        ),
        Spanned(
            Equals,
            182..183,
        ),
        Spanned(
            New,
            184..187,
        ),
        Spanned(
            Name(
                "Resistor",
            ),
            188..196,
        ),
        Spanned(
            Newline,
            196..197,
        ),
        Spanned(
            Name(
                "r1",
            ),
            201..203,
        ),
        Spanned(
            Dot,
            203..204,
        ),
        Spanned(
            Name(
                "value",
            ),
            204..209,
        ),
        Spanned(
            Equals,
            210..211,
        ),
        Spanned(
            Number(
                "10",
            ),
            212..214,
        ),
        Spanned(
            Name(
                "kohm",
            ),
            214..218,
        ),
        Spanned(
            PlusOrMinus,
            219..222,
        ),
        Spanned(
            Number(
                "5",
            ),
            223..224,
        ),
        Spanned(
            Percent,
            224..225,
        ),
        Spanned(
            Newline,
            225..226,
        ),
        Spanned(
            Name(
                "r1",
            ),
            230..232,
        ),
        Spanned(
            Dot,
            232..233,
        ),
        Spanned(
            Name(
                "mpn",
            ),
            233..236,
        ),
        Spanned(
            Equals,
            237..238,
        ),
        Spanned(
            String(
                "MPN123",
            ),
            239..247,
        ),
        Spanned(
            Newline,
            247..248,
        ),
        Spanned(
            Newline,
            248..249,
        ),
        Spanned(
            Assert,
            253..259,
        ),
        Spanned(
            Name(
                "r1",
            ),
            260..262,
        ),
        Spanned(
            Dot,
            262..263,
        ),
        Spanned(
            Name(
                "value",
            ),
            263..268,
        ),
        Spanned(
            Within,
            269..275,
        ),
        Spanned(
            Number(
                "10",
            ),
            276..278,
        ),
        Spanned(
            Name(
                "kohm",
            ),
            278..282,
        ),
        Spanned(
            PlusOrMinus,
            283..286,
        ),
        Spanned(
            Number(
                "5",
            ),
            287..288,
        ),
        Spanned(
            Percent,
            288..289,
        ),
        Spanned(
            Newline,
            289..290,
        ),
        Spanned(
            Newline,
            290..291,
        ),
        Spanned(
            Dedent,
            291..291,
        ),
        Spanned(
            Interface,
            291..300,
        ),
        Spanned(
            Name(
                "TestInterface",
            ),
            301..314,
        ),
        Spanned(
            Colon,
            314..315,
        ),
        Spanned(
            Newline,
            315..316,
        ),
        Spanned(
            Indent,
            316..316,
        ),
        Spanned(
            Signal,
            320..326,
        ),
        Spanned(
            Name(
                "a",
            ),
            327..328,
        ),
        Spanned(
            Newline,
            328..329,
        ),
        Spanned(
            Dedent,
            333..333,
        ),
    ]
    "###);
}

#[test]
fn test_multiline_comment() {
    let input = r#"
component Test:
    """
    This is a
    multi-line comment
    """
    signal a
"#;
    let (tokens, errors) = Lexer::lex(input);
    assert_eq!(errors.len(), 0);

    assert_debug_snapshot!(tokens, @r###"
    [
        Spanned(
            Newline,
            0..1,
        ),
        Spanned(
            Component,
            1..10,
        ),
        Spanned(
            Name(
                "Test",
            ),
            11..15,
        ),
        Spanned(
            Colon,
            15..16,
        ),
        Spanned(
            Newline,
            16..17,
        ),
        Spanned(
            Indent,
            17..17,
        ),
        Spanned(
            Newline,
            24..25,
        ),
        Spanned(
            Comment(
                "This is a",
            ),
            29..38,
        ),
        Spanned(
            Newline,
            38..39,
        ),
        Spanned(
            Comment(
                "multi-line comment",
            ),
            43..61,
        ),
        Spanned(
            Newline,
            61..62,
        ),
        Spanned(
            Newline,
            69..70,
        ),
        Spanned(
            Signal,
            74..80,
        ),
        Spanned(
            Name(
                "a",
            ),
            81..82,
        ),
        Spanned(
            Newline,
            82..83,
        ),
        Spanned(
            Dedent,
            83..83,
        ),
    ]
    "###);
}

#[test]
fn test_same_line_multiline_comment() {
    let input = r#"
component Test:
    signal a  """This is a same-line comment"""
    signal b
"#;
    let (tokens, errors) = Lexer::lex(input);
    assert_eq!(errors.len(), 0);

    assert_debug_snapshot!(tokens, @r###"
    [
        Spanned(
            Newline,
            0..1,
        ),
        Spanned(
            Component,
            1..10,
        ),
        Spanned(
            Name(
                "Test",
            ),
            11..15,
        ),
        Spanned(
            Colon,
            15..16,
        ),
        Spanned(
            Newline,
            16..17,
        ),
        Spanned(
            Indent,
            17..17,
        ),
        Spanned(
            Signal,
            21..27,
        ),
        Spanned(
            Name(
                "a",
            ),
            28..29,
        ),
        Spanned(
            Comment(
                "This is a same-line comment",
            ),
            34..61,
        ),
        Spanned(
            Newline,
            64..65,
        ),
        Spanned(
            Signal,
            69..75,
        ),
        Spanned(
            Name(
                "b",
            ),
            76..77,
        ),
        Spanned(
            Newline,
            77..78,
        ),
        Spanned(
            Dedent,
            78..78,
        ),
    ]
    "###);
}

#[test]
fn test_multiline_comment_with_indentation() {
    let input = r#"
component Test:
    signal a
    """
    This is a multiline comment
        with weird
indentation
    """
    signal b
"#;
    let (tokens, errors) = Lexer::lex(input);
    assert_eq!(errors.len(), 0);

    assert_debug_snapshot!(tokens, @r###"
    [
        Spanned(
            Newline,
            0..1,
        ),
        Spanned(
            Component,
            1..10,
        ),
        Spanned(
            Name(
                "Test",
            ),
            11..15,
        ),
        Spanned(
            Colon,
            15..16,
        ),
        Spanned(
            Newline,
            16..17,
        ),
        Spanned(
            Indent,
            17..17,
        ),
        Spanned(
            Signal,
            21..27,
        ),
        Spanned(
            Name(
                "a",
            ),
            28..29,
        ),
        Spanned(
            Newline,
            29..30,
        ),
        Spanned(
            Newline,
            37..38,
        ),
        Spanned(
            Comment(
                "This is a multiline comment",
            ),
            42..69,
        ),
        Spanned(
            Newline,
            69..70,
        ),
        Spanned(
            Comment(
                "with weird",
            ),
            78..88,
        ),
        Spanned(
            Newline,
            88..89,
        ),
        Spanned(
            Comment(
                "indentation",
            ),
            89..100,
        ),
        Spanned(
            Newline,
            100..101,
        ),
        Spanned(
            Newline,
            108..109,
        ),
        Spanned(
            Signal,
            113..119,
        ),
        Spanned(
            Name(
                "b",
            ),
            120..121,
        ),
        Spanned(
            Newline,
            121..122,
        ),
        Spanned(
            Dedent,
            122..122,
        ),
    ]
    "###);
}
