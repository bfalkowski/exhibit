"""Exhibit's driver for mutmut (docs/spec.md section 9.5).

Exhibit runs this file with the Python of the project, in the project's folder, as
`PYTHON mutmut-driver.py REQUEST`. REQUEST is a JSON file:

    {"files": {"pkg/a.py": [[3, 5], [9, 9]]}, "out": "/tmp/x/out.jsonl", "max_children": 4}

`files` holds the changed lines of each changed Python file, with paths relative to the project.
mutmut 3 has no option for line ranges, but it can mutate only the lines that the tests cover. The
driver gives it the changed lines as the covered lines, so mutmut makes mutants only there.

The driver writes JSON lines to `out`:

- {"error": "..."} when it cannot run mutmut, for example when mutmut is not installed.
- {"left_out": [...], "source_paths": [...]} when mutmut would not mutate some changed files.
- {"mutants": [...]}, one entry for each mutant, before mutmut tests any of them.
- {"done": true} when `mutmut run` finished. Without it, the run did not finish.

mutmut writes the result of each mutant to mutants/<file>.meta as soon as it has it, so Exhibit
reads the results there, also after it stopped the run at the end of the budget.

The driver uses parts of mutmut that are not its public interface, so it needs mutmut 3.8.1 exactly.
Exhibit checks that its list of mutants matches the one in mutmut's .meta files.
"""

import json
import os
import sys
import traceback
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

MUTMUT_VERSION = "3.8.1"


def main(request_path):
    request = json.loads(Path(request_path).read_text("utf-8"))
    out = open(request["out"], "a", encoding="utf-8")

    def write(line):
        out.write(json.dumps(line) + "\n")
        out.flush()

    files = {path: [tuple(r) for r in ranges] for path, ranges in request["files"].items()}
    try:
        found = version("mutmut")
    except PackageNotFoundError:
        write({"error": f"mutmut is not installed in the Python that settings.mutation_python starts ({sys.executable}). Exhibit needs mutmut {MUTMUT_VERSION}."})
        return 3
    if found != MUTMUT_VERSION:
        write({"error": f"The Python that settings.mutation_python starts ({sys.executable}) has mutmut {found}, but Exhibit needs mutmut {MUTMUT_VERSION} exactly."})
        return 3

    # When the project's mutmut config names no source_paths, mutmut guesses them from the folder
    # name, and stops when it cannot guess. Exhibit then gives it the top folders of the changed files.
    import mutmut.configuration as configuration

    guess = configuration._guess_source_paths

    def guess_or_changed_folders():
        try:
            return guess()
        except FileNotFoundError:
            return sorted({path.split("/")[0] for path in files})

    configuration._guess_source_paths = guess_or_changed_folders

    # Importing mutmut.__main__ sets the start method of multiprocessing to fork, so the change
    # below reaches mutmut's worker processes too.
    import mutmut.__main__ as mutmut_main
    from mutmut.configuration import ProcessIsolation, config
    from mutmut.state import state
    from mutmut.utils.file_utils import walk_mutatable_files

    # With mutmut's default, fork, it runs the whole test suite in its main process, and then forks
    # each mutant's test run from that process. A test that keeps state, such as an in-memory
    # store, then fails on the copy of that state, and the mutant counts as killed when it was
    # not. With forkserver, each of those runs starts from a process that has only loaded the
    # tests. So Exhibit always uses forkserver.
    config().process_isolation = ProcessIsolation.FORKSERVER

    walked = {os.path.normpath(str(path)): path for path in walk_mutatable_files()}
    left_out = sorted(path for path in files if os.path.normpath(path) not in walked)
    if left_out:
        write({"left_out": left_out, "source_paths": [str(path) for path in config().source_paths]})
        return 4

    lines = {path: changed_set(ranges) for path, ranges in files.items()}
    write({"mutants": [mutant for path in sorted(files) for mutant in list_mutants(walked[os.path.normpath(path)], path, lines[path])]})

    covered = {str((Path("mutants") / walked[os.path.normpath(path)]).absolute()): lines[path] for path in files}

    def store_changed_lines():
        state()._covered_lines = covered

    mutmut_main.store_lines_covered_by_tests = store_changed_lines
    try:
        mutmut_main._run([], max_children=request["max_children"])
    except SystemExit as stop:
        code = stop.code if isinstance(stop.code, int) else 1
        if code != 0:
            show_plain_test_run(config())
            return code
    write({"done": True})
    return 0


def show_plain_test_run(cfg):
    """Runs the project's tests once with plain pytest, so the log shows what failed.

    With forkserver, mutmut runs the tests in a child process that keeps their output, so when they
    fail, mutmut's log does not say which test failed or why.
    """
    import subprocess

    sys.stdout.flush()
    print("\nExhibit: mutmut stopped. Here is one plain pytest run of the project's tests, to show what failed:", flush=True)
    args = [sys.executable, "-m", "pytest", "-x", "-q", "-p", "no:cacheprovider", *cfg.pytest_add_cli_args, *cfg.pytest_add_cli_args_test_selection]
    result = subprocess.run(args, check=False)
    if result.returncode == 0:
        print("\nExhibit: the tests pass with plain pytest. So the cause is likely in how mutmut runs them: from a copy of the code in the folder mutants, one folder deeper. Code that finds files from its own path then misses them.", flush=True)


def changed_set(ranges):
    return {line for first, last in ranges for line in range(first, last + 1)}


def list_mutants(walked_path, path, changed):
    """The mutants that mutmut makes in one file, on the changed lines, in mutmut's order.

    It makes them as mutmut's create_mutations does, and names them as combine_mutations_to_source
    does. It records each one's line, column, mutator, and code before and after.
    """
    import libcst as cst
    from libcst.metadata import MetadataWrapper, PositionProvider
    from mutmut.mutation import file_mutation as fm
    from mutmut.utils.format_utils import get_mutant_name

    code = Path(walked_path).read_text("utf-8")
    try:
        module = cst.parse_module(code)
    except cst.ParserSyntaxError:
        # mutmut copies a file that libcst cannot parse, and makes no mutant in it.
        return []
    wrapper = MetadataWrapper(module)
    ignored = fm.get_ignored_lines(str(walked_path), code, wrapper, set())
    mutator_by_node = {}

    def named(operator):
        def run(node):
            for mutated in operator(node):
                mutator_by_node[id(mutated)] = operator.__name__.removeprefix("operator_")
                yield mutated

        return run

    class Recorder(fm.MutationVisitor):
        def __init__(self, *args):
            super().__init__(*args)
            self.position_by_mutation = {}

        def _create_mutations(self, node):
            before = len(self.mutations)
            super()._create_mutations(node)
            position = self.get_metadata(PositionProvider, node, None)
            for mutation in self.mutations[before:]:
                self.position_by_mutation[id(mutation)] = position

    visitor = Recorder([(kind, named(operator)) for kind, operator in fm.mutation_operators], ignored, changed)
    module = wrapper.visit(visitor)
    grouped = fm.group_by_top_level_node(visitor.mutations)
    render = cst.Module(body=[]).code_for_node

    found = []

    def add(function, class_name):
        prefix = fm.mangle_function_name(name=function.name.value, class_name=class_name) + "__mutmut"
        for i, mutation in enumerate(grouped.get(function, [])):
            position = visitor.position_by_mutation[id(mutation)]
            found.append({
                "name": get_mutant_name(Path(walked_path), f"{prefix}_{i + 1}"),
                "file": path,
                "line": position.start.line,
                # libcst counts columns from 0, Stryker and Exhibit from 1.
                "column": position.start.column + 1,
                "mutator": mutator_by_node.get(id(mutation.mutated_node), "unknown"),
                "original": render(mutation.original_node),
                "replacement": render(mutation.mutated_node),
            })

    for statement in module.body:
        if isinstance(statement, cst.FunctionDef):
            add(statement, None)
        elif isinstance(statement, cst.ClassDef) and isinstance(statement.body, cst.IndentedBlock):
            for method in statement.body.body:
                if isinstance(method, cst.FunctionDef):
                    add(method, statement.name.value)
    return found


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1]))
    except SystemExit:
        raise
    except BaseException:
        traceback.print_exc()
        sys.exit(1)
