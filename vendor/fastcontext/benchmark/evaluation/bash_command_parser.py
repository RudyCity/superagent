import json

# uv pip install --upgrade tree-sitter
# uv pip install tree-sitter-language-pack
from tree_sitter_language_pack import get_parser


def search_node_by_type(node, type_name: str):
    results = []
    if node.type == type_name:
        results.append(node)
    for child in node.children:
        results.extend(search_node_by_type(child, type_name))
    return results


def parse_shell_script(script_content: str) -> list[str] | None:
    try:
        bash_parser = get_parser("bash")  # this is an instance of tree_sitter.Parser
        tree = bash_parser.parse(bytes(script_content, "utf8"))
        root_node = tree.root_node
        if root_node.has_error:
            return None
        command_nodes = search_node_by_type(root_node, "command")
        command_names = [node.child_by_field_name("name") for node in command_nodes]
        command_names = [node.text.decode() for node in command_names if node]
        # Handle cases where command might have path (e.g., /bin/ls -> ls)
        command_names = [name.split("/")[-1] for name in command_names]
    except ValueError:
        command_names = None
    return command_names


if __name__ == "__main__":
    # Example usage
    script = """
    #!/bin/bash
    echo "Hello, World!" && ls -l /home/user && echo "Done"
    cat file.txt
    """
    commands = parse_shell_script(script)
    print(json.dumps(commands, indent=2))
