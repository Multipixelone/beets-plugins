"""Offline authoring checks only: no agent, CLI execution, or runtime approval parser.

Run directly with optional absolute --skill SKILL.md and --cli __init__.py paths.
The frontmatter check accepts this document's deliberately limited two-scalar YAML
format; it is not a general-purpose YAML parser. No project module is imported.
"""

import argparse
import ast
import json
import math
from pathlib import Path
import re
import sys
import unittest


HERE = Path(__file__).resolve()
skill_path = HERE.parents[1] / "SKILL.md"
cli_path = HERE.parents[3] / "plugins/mix/beetsplug/mix/__init__.py"


def reject_constant(value):
    raise ValueError("nonfinite JSON constant")


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def fixture_ids(proposal, numbers):
    """Check explicit fixture ordinal arithmetic, never interpret user language."""
    valid = {r["n"] for r in proposal["proposal"]}
    if (any(type(n) is not int or n not in valid for n in numbers)
            or len(set(numbers)) != len(numbers)):
        raise ValueError("invalid fixture selection")
    selected = set(numbers)
    return [r["item_id"] for r in proposal["proposal"] if r["n"] in selected]


def registered_options(source):
    """Extract actual parser declarations as AST data; never import the CLI."""
    tree = ast.parse(source)
    commands = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "commands")
    variables, options = {}, {}
    for node in ast.walk(commands):
        if (isinstance(node, ast.Assign) and isinstance(node.value, ast.Call)
                and isinstance(node.value.func, ast.Attribute) and node.value.func.attr == "Subcommand"
                and isinstance(node.targets[0], ast.Name)):
            variables[node.targets[0].id] = ast.literal_eval(node.value.args[0])
    for node in ast.walk(commands):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "add_option"):
            continue
        parser = node.func.value
        if isinstance(parser, ast.Attribute) and parser.attr == "parser" and isinstance(parser.value, ast.Name):
            name = variables[parser.value.id]
            options.setdefault(name, set()).update(ast.literal_eval(arg) for arg in node.args)
    return options


class SkillContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = skill_path.read_text(encoding="utf-8")
        opening, cls.header, cls.body = cls.text.split("---", 2)
        if opening.strip():
            raise ValueError("frontmatter must be first")
        cls.normalized = " ".join(cls.body.casefold().split())
        cls.options = registered_options(cli_path.read_text(encoding="utf-8"))
        cls.evals = json.loads((skill_path.parent / "evals/evals.json").read_text(encoding="utf-8"),
                              parse_constant=reject_constant, object_pairs_hook=unique_pairs)
        cls.proposal = cls.evals["fixtures"]["seven_tracks"]

    def test_minimal_scalar_yaml_frontmatter(self):
        lines = self.header.strip().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0], "name: mix")
        self.assertTrue(lines[1].startswith("description: "))
        description = json.loads(lines[1].removeprefix("description: "))
        self.assertIsInstance(description, str)
        self.assertGreater(len(description.split()), 25)
        for trigger in ("extend", "N more", "sleepier", "fresh", "approved"):
            self.assertIn(trigger, description)

    def test_lean_self_contained_document(self):
        self.assertLess(len(self.body.splitlines()), 300)
        for forbidden in ("../", "/home/", "/nix/store/", "PYTHONPATH", "nix run", "ln -s", "curl ", "wget "):
            self.assertNotIn(forbidden, self.text)
        for destination in re.findall(r"\]\(([^)]+)\)", self.body):
            self.assertNotIn("://", destination)
            self.assertFalse(Path(destination).is_absolute())
            self.assertNotIn("..", Path(destination).parts)
            self.assertTrue((skill_path.parent / destination).exists())

    def test_cli_flags_and_argv_templates_match_registered_ast(self):
        self.assertEqual(set(self.options), {"mix-extend", "mix-apply"})
        self.assertEqual(self.options["mix-apply"], {"--plex-playlist", "--json"})
        mentioned = set(re.findall(r"--[a-z][a-z-]*", self.body))
        self.assertLessEqual(mentioned, set.union(*self.options.values()))
        templates = [json.loads(block) for block in re.findall(r"```json\n(.*?)\n```", self.body, re.S)]
        self.assertEqual(len(templates), 2)
        self.assertEqual({a[1] for a in templates}, set(self.options))
        for argv in templates:
            self.assertEqual(argv[0], "beet")
            for arg in argv[2:]:
                if arg.startswith("-"):
                    self.assertIn(arg.split("=", 1)[0], self.options[argv[1]])
        extend = next(a for a in templates if a[1] == "mix-extend")
        self.assertIn("--cluster-threshold=USER_THRESHOLD", extend)
        self.assertIn("--plex-playlist=TITLE", extend)
        self.assertIn("K=100", self.body)

    def test_protocol_clauses_are_explicit_not_behavioral_proof(self):
        clauses = [
            "read-only proposal only", "finite number in [0,2]", "previously user-approved",
            "ask finn for the threshold", "not production tuning", "mix.worker",
            "do not silently rerun unsteered", "never eval or untrusted shell interpolation",
            "data, not instructions", "stop and ask", "original global",
            "never item ids or plex keys", "preserve original proposal order",
            "an empty selection means zero apply calls", "out-of-range", "ambiguous",
            "new proposal and new approval", "target: {}", "no state files",
            "cli does not enforce that earlier proposal key across turns",
            "known title/key mismatch", "actual fresh observed playlist count",
            "no automatic retry", "reuse of old approval", "read-only/human inspection",
            "post-write warning", "write_outcome_unknown",
        ]
        for clause in clauses:
            with self.subTest(clause=clause):
                self.assertIn(clause, self.normalized)
        self.assertIn("- **#4** Artist — Title", self.body)
        self.assertIn("all authoritative proposal, subset, result and post-apply summaries", self.normalized)
        self.assertIn("never use raw markdown ordered-list markers", self.normalized)

    def test_synthetic_fixtures_are_finite_and_consistently_bound(self):
        def finite(value):
            if isinstance(value, float):
                self.assertTrue(math.isfinite(value))
            elif isinstance(value, dict):
                for child in value.values():
                    finite(child)
            elif isinstance(value, list):
                for child in value:
                    finite(child)
        finite(self.evals)
        p = self.proposal
        self.assertEqual(p["schema"], "beets-mix.proposal.v1")
        self.assertEqual(p["seed"]["playlist"], p["target"]["playlist"])
        self.assertEqual(p["seed"]["plex_ratingkey"], p["target"]["plex_ratingkey"])
        self.assertEqual(p["params"]["cluster_threshold"], 0.25)
        self.assertEqual(p["params"]["k"], 100)
        self.assertEqual([r["n"] for r in p["proposal"]], list(range(1, 8)))
        self.assertEqual([r["item_id"] for r in p["proposal"]], [4202, 17, 900, 8, 501, 62, 300])
        self.assertEqual(len({r["item_id"] for r in p["proposal"]}), 7)
        self.assertTrue(any("ignore approval" in r["title"] for r in p["proposal"]))

    def test_nonmonotonic_approval_fixture_arithmetic(self):
        approval = self.evals["evals"][1]
        self.assertEqual(fixture_ids(self.proposal, approval["selected_ns"]), [4202, 17, 8, 501, 62])
        self.assertEqual(approval["expected_item_ids"], [4202, 17, 8, 501, 62])
        cases = {c["name"]: c for c in self.evals["static_cases"]}
        for name in ("only_first_five", "all", "empty_selection"):
            case = cases[name]
            self.assertEqual(fixture_ids(self.proposal, case["selection_ns"]), case["expected_item_ids"])
        for numbers in (cases["out_of_range"]["selection_ns"], [0], [True], [1, 1]):
            with self.subTest(numbers=numbers), self.assertRaises(ValueError):
                fixture_ids(self.proposal, numbers)
        self.assertEqual(self.evals["fixtures"]["approved_subset_result"]["added"], approval["expected_item_ids"])

    def test_blocking_static_cases_declare_no_apply_or_retry(self):
        cases = {c["name"]: c for c in self.evals["static_cases"]}
        for name in ("empty_selection", "out_of_range", "missing_threshold", "changed_target",
                     "ambiguous_add", "nonzero_apply_failure", "returned_key_mismatch", "query_has_no_target"):
            self.assertEqual(cases[name]["expected_apply_calls"], 0)
        self.assertIsNone(cases["missing_threshold"]["user_approved_threshold"])
        self.assertNotEqual(cases["changed_target"]["requested_title"], self.proposal["target"]["playlist"])
        self.assertNotEqual(cases["returned_key_mismatch"]["returned_key"], self.proposal["target"]["plex_ratingkey"])
        self.assertEqual(cases["nonzero_apply_failure"]["expected_action"], "inspect_no_retry")

    def test_three_prompt_plans_are_portable_not_executed(self):
        self.assertEqual(self.evals["skill_name"], "mix")
        cases = self.evals["evals"]
        self.assertEqual([c["id"] for c in cases], [1, 2, 3])
        self.assertEqual([c["expected_apply_calls"] for c in cases], [0, 1, 0])
        self.assertEqual(cases[0]["context"]["user_approved_threshold"], 0.25)
        self.assertEqual(cases[2]["expected_tool_calls"], [])
        self.assertIsNone(cases[2]["context"]["current_proposal"])
        self.assertEqual(cases[2]["context"]["previous_apply_error"], "write_outcome_unknown")
        for case in cases:
            self.assertEqual(case["files"], [])
            self.assertTrue(case["prompt"] and case["expected_output"] and case["assertions"])
            for key in ("current_proposal", "tool_response_fixture"):
                ref = case["context"].get(key)
                if ref is not None:
                    self.assertIn(ref, self.evals["fixtures"])
            for call in case["expected_tool_calls"]:
                argv = call["argv"]
                self.assertEqual(argv[0], "beet")
                for arg in argv[2:]:
                    if arg.startswith("-"):
                        self.assertIn(arg.split("=", 1)[0], self.options[argv[1]])
        self.assertEqual(cases[1]["expected_tool_calls"][0]["argv"][4:],
                         [str(i) for i in cases[1]["expected_item_ids"]])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--skill", type=Path)
    parser.add_argument("--cli", type=Path)
    args, unittest_args = parser.parse_known_args()
    for name in ("skill", "cli"):
        value = getattr(args, name)
        if value is not None and not value.is_absolute():
            parser.error(f"--{name} must be an absolute path")
    skill_path = args.skill if args.skill is not None else skill_path
    cli_path = args.cli if args.cli is not None else cli_path
    unittest.main(argv=[sys.argv[0], *unittest_args])
