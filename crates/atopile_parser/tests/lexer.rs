use atopile_parser::lexer::lex;
use std::fs;

macro_rules! create_lexer_test {
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
            let output = lex(&normalized_input);
            insta::assert_debug_snapshot!(output);
        }
    };
}

create_lexer_test!(vdivs);
create_lexer_test!(resistors);
create_lexer_test!(transistors);
