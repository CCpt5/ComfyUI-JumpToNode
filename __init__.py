"""
ComfyUI-JumpToNode
Adds Ctrl+G hotkey and a "Go to node..." canvas context menu item that jumps
to a node by numeric ID or subgraph path (e.g. 110, 82:485, 15:371:435).

Pure front-end extension - no Python nodes registered.
"""

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
