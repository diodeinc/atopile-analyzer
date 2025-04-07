use atopile_parser::lexer::lex;
use atopile_parser::parser::parse;
use std::fs;

macro_rules! create_parser_test {
    ($name:ident) => {
        #[test]
        fn $name() {
            let input = fs::read_to_string(concat!(
                "tests/resources/corpus/",
                stringify!($name),
                ".ato"
            ))
            .unwrap();

            let normalized_input = input.replace("\r\n", "\n");

            let tokens = lex(&normalized_input).0;
            let output = parse(&tokens);

            for err in output.1.iter() {
                println!("Error: {:?}", err);
                println!("Context tokens:");
                let span = err.span();
                tokens
                    .iter()
                    .enumerate()
                    .filter(|(i, _)| {
                        *i >= span.start.saturating_sub(5) && *i <= span.end.saturating_add(5)
                    })
                    .for_each(|(i, t)| {
                        println!(
                            "{}{:2}: {:?}",
                            if span.into_range().contains(&i) {
                                "-> "
                            } else {
                                "   "
                            },
                            i,
                            t
                        )
                    });
                println!("---");
            }

            insta::assert_debug_snapshot!(output);
        }
    };
}

create_parser_test!(vdivs);
create_parser_test!(resistors);
create_parser_test!(transistors);
create_parser_test!(bma400);
