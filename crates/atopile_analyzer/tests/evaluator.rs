use atopile_analyzer::evaluator::Evaluator;
use atopile_parser::AtopileSource;
use std::fs;
use std::path::PathBuf;

macro_rules! create_evaluator_test {
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

            let file_path = concat!("tests/resources/corpus/", stringify!($name), ".ato");
            let path_buf = PathBuf::from(file_path);
            
            let (source, _errors) = AtopileSource::new(
                normalized_input.to_string(),
                path_buf.clone(),
            );
            
            let mut evaluator = Evaluator::new();
            let result = evaluator.evaluate(&source);

            insta::assert_debug_snapshot!(result);
        }
    };
}

create_evaluator_test!(vdivs);
create_evaluator_test!(resistors);
create_evaluator_test!(transistors);
create_evaluator_test!(bma400);
