#!/usr/bin/env python3
"""Check authored Markdown links using Python's standard library; no network calls."""

import argparse
import json
from pathlib import Path
import re
import os
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]
EXCLUDED_DIRECTORIES = {
    ".git", ".cache", ".framework", ".venv", "venv", "node_modules",
    "generated", "dist", ".dist", "build", "cdk.out", "coverage", "test-results",
    "playwright-report", "__pycache__",
}
INLINE_LINK = re.compile(
    r'!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))'
    r'(?:\s+(?:"[^"\n]*"|\x27[^\x27\n]*\x27))?\s*\)'
)
DEFINITION = re.compile(r'^ {0,3}\[([^\]\n]+)\]:\s*(?:<([^>\n]+)>|(\S+)).*$', re.M)


def markdown_files():
    """Include hidden agent guidance; omit dependency/build/browser-output artifacts."""
    found = []
    for directory, children, names in os.walk(ROOT, followlinks=False):
        folder = Path(directory)
        children[:] = sorted(
            name for name in children
            if name not in EXCLUDED_DIRECTORIES
            and not (folder == ROOT and name == "output")
            and not (folder / name).is_symlink()
        )
        found.extend(folder / name for name in sorted(names)
                     if name.endswith(".md") and not (folder / name).is_symlink())
    return found


def without_fences(text):
    """Preserve line numbers while ignoring fenced examples and frontmatter."""
    result = []
    fence = None
    frontmatter = text.startswith("---\n")
    for number, line in enumerate(text.splitlines()):
        if frontmatter:
            result.append("")
            if number and line == "---":
                frontmatter = False
            continue
        marker = re.match(r'^ {0,3}(`{3,}|~{3,})(.*)$', line)
        if fence:
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence) and not marker[2].strip():
                fence = None
            result.append("")
        elif marker:
            fence = marker[1]
            result.append("")
        else:
            result.append(line)
    return "\n".join(result)


def headings(text):
    body = without_fences(text)
    titles = []
    lines = body.splitlines()
    for position, line in enumerate(lines):
        heading = re.match(r'^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$', line)
        if heading:
            titles.append(heading[1])
        elif position and re.fullmatch(r' {0,3}(?:=+|-+)\s*', line):
            previous = lines[position - 1].strip()
            if previous and not re.match(r'[#>|*+\-]', previous):
                titles.append(previous)
    identifiers = set()
    for title in titles:
        title = re.sub(r'<[^>]*>', '', title)
        title = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', title)
        title = re.sub(r'[`*_~]', '', title).lower()
        base = ''.join(character for character in title
                       if character.isalnum() or character in '_-' or character.isspace())
        base = re.sub(r'\s', '-', base)
        slug = base
        number = 1
        while slug in identifiers:
            slug = f'{base}-{number}'
            number += 1
        identifiers.add(slug)
    identifiers.update(match[1] for match in re.finditer(
        r'<(?:a|h[1-6])\b[^>]*(?:id|name)=["\x27]([^"\x27]+)["\x27]', body, re.I))
    return identifiers


def normalize_reference(label):
    return re.sub(r'\s+', ' ', label.strip()).lower()


def links(text):
    body = without_fences(text)
    # An inline code example is not navigation. Retain its width and line numbers.
    body = re.sub(r'(`+)([^`\n]*?)\1', lambda match: ' ' * len(match[0]), body)
    definitions = {normalize_reference(match[1]): match[2] or match[3]
                   for match in DEFINITION.finditer(body)}
    body = DEFINITION.sub(lambda match: ' ' * len(match[0]), body)
    found = []
    occupied = []
    for match in INLINE_LINK.finditer(body):
        found.append((match[1] or match[2], body[:match.start()].count('\n') + 1, None))
        occupied.append(match.span())
    for match in re.finditer(r'!?\[([^\]\n]+)\]\[([^\]\n]*)\]', body):
        label = normalize_reference(match[2] or match[1])
        found.append((definitions.get(label), body[:match.start()].count('\n') + 1,
                      None if label in definitions else f'undefined reference: {label}'))
        occupied.append(match.span())
    for match in re.finditer(r'!?\[([^\]\n]+)\](?![\[(])', body):
        if any(start <= match.start() < end for start, end in occupied):
            continue
        label = normalize_reference(match[1])
        if label in definitions:
            found.append((definitions[label], body[:match.start()].count('\n') + 1, None))
    return found


def check():
    files = markdown_files()
    errors = []
    counts = {"markdown_files": len(files), "local_links": 0,
              "heading_links": 0, "external_links_not_fetched": 0}
    anchor_cache = {}
    graph = {}
    for file in files:
        graph[file] = set()
        for raw, line, problem in links(file.read_text(encoding="utf-8")):
            if problem:
                errors.append(f'{file.relative_to(ROOT)}:{line}: {problem}')
                continue
            if re.match(r'^(?:[a-z][a-z0-9+.-]*:|//)', raw, re.I):
                counts["external_links_not_fetched"] += 1
                continue
            target_text, _, fragment = unquote(raw).partition('#')
            pathname = target_text.split('?')[0]
            destination = (file.parent / pathname).resolve() if pathname else file
            counts["local_links"] += 1
            if not destination.is_relative_to(ROOT):
                problem = 'path leaves repository'
            elif not destination.exists():
                problem = 'missing path'
            elif fragment and destination.suffix == '.md' and destination.is_file():
                counts["heading_links"] += 1
                if destination not in anchor_cache:
                    anchor_cache[destination] = headings(destination.read_text(encoding="utf-8"))
                if fragment not in anchor_cache[destination]:
                    problem = 'missing heading'
            if problem:
                errors.append(f'{file.relative_to(ROOT)}:{line}: {problem}: {raw}')
            else:
                graph[file].add(destination)
    reached = set()
    queue = [ROOT / 'README.md', ROOT / 'AGENTS.md']
    while queue:
        file = queue.pop()
        if file in reached or file not in graph:
            continue
        reached.add(file)
        queue.extend(graph[file])
    counts["reachable_from_readme_or_agents"] = len(reached)
    # Navigation omissions are reported separately, not treated as broken links.
    unlinked = [str(file.relative_to(ROOT)) for file in files if file not in reached]
    return {**counts, "unlinked_documents": unlinked, "errors": errors}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--json', action='store_true', help='Print machine-readable counts and errors.')
    arguments = parser.parse_args()
    result = check()
    if arguments.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"Checked {result['markdown_files']} Markdown files, {result['local_links']} local links "
              f"and {result['heading_links']} heading references; "
              f"{result['external_links_not_fetched']} external links were not fetched.")
        print(f"Reachable from README/AGENTS: {result['reachable_from_readme_or_agents']}.")
        for file in result['unlinked_documents']:
            print(f'Unlinked document: {file}')
        for error in result['errors']:
            print(error)
        if not result['errors']:
            print('Local Markdown links passed.')
    raise SystemExit(1 if result['errors'] else 0)
