// Verified tools/list and tools/call from OpenPencil 0.8.5 (revision 442c48418697ae944db8bad5bad57f62ee57b1cc). Technical schemas only.
// Native lists insert_* kit shortcuts but dispatches none (registry gates them on add_*); omit those unavailable entries.
export const NATIVE_CATALOG = [
  {
    name: "get_document_info",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_selection",
    inputSchema: {
      type: "object",
      properties: {
        readDepth: {
          type: "number",
        },
      },
    },
  },
  {
    name: "get_node",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
      },
      required: ["node_id"],
    },
  },
  {
    name: "list_pages",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_variables",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_variables",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "upsert_variables",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
        },
        variables: {
          oneOf: [
            {
              type: "object",
            },
            {
              type: "string",
            },
          ],
        },
        sourcePath: {
          type: "string",
        },
        sourceHash: {
          type: "string",
        },
      },
      required: ["key", "variables"],
    },
  },
  {
    name: "upsert_component",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
        },
        name: {
          type: "string",
        },
        node_json: {
          oneOf: [
            {
              type: "object",
            },
            {
              type: "string",
            },
          ],
        },
        sourcePath: {
          type: "string",
        },
        sourceHash: {
          type: "string",
        },
      },
      required: ["key", "name", "node_json"],
    },
  },
  {
    name: "upsert_screen",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
        },
        node_json: {
          oneOf: [
            {
              type: "object",
            },
            {
              type: "string",
            },
          ],
        },
        sourcePath: {
          type: "string",
        },
        sourceHash: {
          type: "string",
        },
      },
      required: ["key", "node_json"],
    },
  },
  {
    name: "conversion_status",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["token", "component", "screen"],
        },
      },
    },
  },
  {
    name: "lint_document",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: {
          type: "string",
        },
      },
    },
  },
  {
    name: "list_theme_presets",
    inputSchema: {
      type: "object",
      properties: {
        directory: {
          type: "string",
        },
      },
      required: ["directory"],
    },
  },
  {
    name: "get_style_guide_tags",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_style_guide",
    inputSchema: {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: {
            type: "string",
          },
        },
        name: {
          type: "string",
        },
        platform: {
          type: "string",
          enum: ["webapp", "mobile", "landing-page", "slides"],
        },
      },
    },
  },
  {
    name: "list_style_guides",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
        },
        tag: {
          type: "string",
        },
        platform: {
          type: "string",
          enum: ["webapp", "mobile", "landing-page", "slides"],
        },
      },
    },
  },
  {
    name: "get_guidelines",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["guide", "style"],
          default: "guide",
        },
        topic: {
          type: "string",
          enum: [
            "web-app",
            "mobile",
            "code-to-design",
            "landing-page",
            "dashboard",
            "slides",
            "form",
            "design-system",
            "interactivity",
          ],
        },
        name: {
          type: "string",
        },
        colorPalette: {
          type: "string",
        },
        roundness: {
          type: "string",
        },
        elevation: {
          type: "string",
        },
        headings: {
          type: "string",
        },
        body: {
          type: "string",
        },
        captions: {
          type: "string",
        },
        data: {
          type: "string",
        },
        decorativeImagery: {
          type: "string",
        },
      },
    },
  },
  {
    name: "get_screenshot",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: {
          type: "string",
        },
      },
      required: ["nodeId"],
    },
  },
  {
    name: "get_deck_boards",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "list_scene_templates",
    inputSchema: {
      type: "object",
      properties: {
        scene: {
          type: "string",
        },
        tag: {
          type: "string",
        },
      },
    },
  },
  {
    name: "use_scene_template",
    inputSchema: {
      type: "object",
      properties: {
        templateId: {
          type: "string",
        },
      },
      required: ["templateId"],
    },
  },
  {
    name: "get_active_theme",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "list_components",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "list_ui_kits",
    inputSchema: {
      type: "object",
      properties: {
        kitId: {
          type: "string",
        },
        query: {
          type: "string",
        },
        category: {
          type: "string",
          enum: [
            "buttons",
            "inputs",
            "cards",
            "navigation",
            "layout",
            "feedback",
            "data-display",
            "other",
          ],
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 50,
        },
      },
    },
  },
  {
    name: "get_component",
    inputSchema: {
      type: "object",
      properties: {
        component_id: {
          type: "string",
        },
      },
      required: ["component_id"],
    },
  },
  {
    name: "batch_get",
    inputSchema: {
      type: "object",
      properties: {
        patterns: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
              },
              name: {
                type: "string",
              },
              reusable: {
                type: "boolean",
              },
            },
          },
        },
        nodeIds: {
          type: "array",
          items: {
            type: "string",
          },
        },
        parentId: {
          type: "string",
        },
        readDepth: {
          type: "number",
        },
        searchDepth: {
          type: "number",
        },
        pageId: {
          type: "string",
        },
        resolveRefs: {
          type: "boolean",
        },
        resolve_refs: {
          type: "boolean",
        },
      },
    },
  },
  {
    name: "read_nodes",
    inputSchema: {
      type: "object",
      properties: {
        nodeIds: {
          type: "array",
          items: {
            type: "string",
          },
        },
        depth: {
          type: "number",
        },
        pageId: {
          type: "string",
        },
        includeVariables: {
          type: "boolean",
        },
      },
    },
  },
  {
    name: "search_all_unique_properties",
    inputSchema: {
      type: "object",
      properties: {
        parents: {
          type: "array",
          items: {
            type: "string",
          },
        },
        properties: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "fillColor",
              "textColor",
              "strokeColor",
              "strokeThickness",
              "cornerRadius",
              "padding",
              "gap",
              "fontSize",
              "fontFamily",
              "fontWeight",
            ],
          },
        },
        pageId: {
          type: "string",
        },
      },
      required: ["parents", "properties"],
    },
  },
  {
    name: "replace_all_matching_properties",
    inputSchema: {
      type: "object",
      properties: {
        parents: {
          type: "array",
          items: {
            type: "string",
          },
        },
        properties: {
          type: "object",
        },
        pageId: {
          type: "string",
        },
      },
      required: ["parents", "properties"],
    },
  },
  {
    name: "snapshot_layout",
    inputSchema: {
      type: "object",
      properties: {
        parentId: {
          type: "string",
        },
        maxDepth: {
          type: "number",
        },
        pageId: {
          type: "string",
        },
      },
    },
  },
  {
    name: "find_empty_space",
    inputSchema: {
      type: "object",
      properties: {
        width: {
          type: "string",
        },
        height: {
          type: "string",
        },
        padding: {
          type: "string",
        },
        direction: {
          type: "string",
          enum: ["top", "right", "bottom", "left"],
        },
        nodeId: {
          type: "string",
        },
        pageId: {
          type: "string",
        },
      },
      required: ["width", "height", "direction"],
    },
  },
  {
    name: "get_canvas_bounds",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "find_node_by_name",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "get_node_parent",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
      },
      required: ["node_id"],
    },
  },
  {
    name: "get_node_children",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
      },
      required: ["node_id"],
    },
  },
  {
    name: "count_nodes",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "list_node_kinds",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_history_depth",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_viewport",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_selection_set",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_editor_state",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_design_quality",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "clear_selection",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "set_selection",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
      },
      required: ["node_id"],
    },
  },
  {
    name: "set_viewport",
    inputSchema: {
      type: "object",
      properties: {
        pan_x: {
          type: "string",
        },
        pan_y: {
          type: "string",
        },
        zoom_percent: {
          type: "string",
        },
      },
    },
  },
  {
    name: "set_node_hidden",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
        value: {
          type: "string",
          enum: ["true", "false"],
        },
      },
      required: ["node_id", "value"],
    },
  },
  {
    name: "set_node_locked",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
        value: {
          type: "string",
          enum: ["true", "false"],
        },
      },
      required: ["node_id", "value"],
    },
  },
  {
    name: "set_node_collapsed",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
        value: {
          type: "string",
          enum: ["true", "false"],
        },
      },
      required: ["node_id", "value"],
    },
  },
  {
    name: "set_active_tool",
    inputSchema: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          enum: [
            "select",
            "rect",
            "ellipse",
            "polygon",
            "line",
            "pen",
            "text",
            "frame",
            "hand",
          ],
        },
      },
      required: ["tool"],
    },
  },
  {
    name: "undo",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "redo",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "duplicate_selected",
    inputSchema: {
      type: "object",
      properties: {
        offset_px: {
          type: "string",
        },
      },
    },
  },
  {
    name: "delete_selected",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "nudge_selected",
    inputSchema: {
      type: "object",
      properties: {
        dx: {
          type: "string",
        },
        dy: {
          type: "string",
        },
      },
      required: ["dx", "dy"],
    },
  },
  {
    name: "group_selected",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "ungroup_selected",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "reorder_selected",
    inputSchema: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["up", "down"],
        },
      },
      required: ["direction"],
    },
  },
  {
    name: "set_node_rotation",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
        degrees: {
          type: "string",
        },
      },
      required: ["node_id", "degrees"],
    },
  },
  {
    name: "set_node_text",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
        text: {
          type: "string",
        },
      },
      required: ["node_id", "text"],
    },
  },
  {
    name: "set_node_corner_radius",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
        radius: {
          type: "string",
        },
      },
      required: ["node_id", "radius"],
    },
  },
  {
    name: "set_node_font_size",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
        font_size: {
          type: "string",
        },
      },
      required: ["node_id", "font_size"],
    },
  },
  {
    name: "set_node_font_weight",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
        font_weight: {
          type: "string",
        },
      },
      required: ["node_id", "font_weight"],
    },
  },
  {
    name: "set_node_stroke_hex",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
        hex: {
          type: "string",
        },
      },
      required: ["node_id", "hex"],
    },
  },
  {
    name: "set_node_stroke_width",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
        width: {
          type: "string",
        },
      },
      required: ["node_id", "width"],
    },
  },
  {
    name: "set_node_stroke_side_width",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
        side: {
          type: "string",
          enum: ["top", "right", "bottom", "left"],
        },
        width: {
          type: "string",
        },
      },
      required: ["node_id", "side", "width"],
    },
  },
  {
    name: "align_selected",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "set_node_fill_hex",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
        hex: {
          type: "string",
        },
      },
      required: ["node_id", "hex"],
    },
  },
  {
    name: "set_node_flip",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
        flip_x: {
          type: "string",
          enum: ["true", "false"],
        },
        flip_y: {
          type: "string",
          enum: ["true", "false"],
        },
      },
      required: ["node_id"],
    },
  },
  {
    name: "set_ellipse_arc",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
        start_angle: {
          type: "string",
        },
        sweep_angle: {
          type: "string",
        },
        inner_radius: {
          type: "string",
        },
      },
      required: ["node_id"],
    },
  },
  {
    name: "add_node_effect",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
        kind: {
          type: "string",
          enum: ["shadow", "blur", "background_blur"],
        },
      },
      required: ["node_id", "kind"],
    },
  },
  {
    name: "remove_node_effect",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
        index: {
          type: "string",
        },
      },
      required: ["node_id", "index"],
    },
  },
  {
    name: "set_node_name",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
        name: {
          type: "string",
        },
      },
      required: ["node_id", "name"],
    },
  },
  {
    name: "set_selection_set",
    inputSchema: {
      type: "object",
      properties: {
        node_ids: {
          type: "string",
        },
      },
      required: ["node_ids"],
    },
  },
  {
    name: "toggle_node_selection",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
      },
      required: ["node_id"],
    },
  },
  {
    name: "cycle_active_axis_value",
    inputSchema: {
      type: "object",
      properties: {
        axis: {
          type: "string",
        },
      },
      required: ["axis"],
    },
  },
  {
    name: "set_variable_color",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
        },
        hex: {
          type: "string",
        },
      },
      required: ["name", "hex"],
    },
  },
  {
    name: "batch_design",
    inputSchema: {
      type: "object",
      properties: {
        nodes_json: {
          type: "string",
        },
        operations: {
          type: "string",
        },
        script: {
          type: "string",
        },
        postProcess: {
          type: "boolean",
          default: false,
        },
        canvasWidth: {
          type: "number",
        },
        pageId: {
          type: "string",
        },
      },
    },
  },
  {
    name: "enrich_images",
    inputSchema: {
      type: "object",
      properties: {
        timeout_seconds: {
          type: "number",
        },
        root_ids: {
          type: "array",
          items: {
            type: "string",
          },
        },
      },
      required: [],
    },
  },
  {
    name: "set_variable_number",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
        },
        value: {
          type: "string",
        },
      },
      required: ["name", "value"],
    },
  },
  {
    name: "set_variable_string",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
        },
        value: {
          type: "string",
        },
      },
      required: ["name", "value"],
    },
  },
  {
    name: "set_variable_boolean",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
        },
        value: {
          type: "string",
          enum: ["true", "false"],
        },
      },
      required: ["name", "value"],
    },
  },
  {
    name: "set_variables",
    inputSchema: {
      type: "object",
      properties: {
        variables: {
          type: "object",
        },
        replace: {
          type: "boolean",
        },
      },
      required: ["variables"],
    },
  },
  {
    name: "apply_design_system",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          enum: ["halo", "lunaris", "nitro", "shadcn"],
        },
      },
      required: ["name"],
    },
  },
  {
    name: "set_themes",
    inputSchema: {
      type: "object",
      properties: {
        themes: {
          type: "object",
        },
        replace: {
          type: "boolean",
        },
      },
      required: ["themes"],
    },
  },
  {
    name: "create_variable",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
        },
        kind: {
          type: "string",
          enum: ["color", "number", "boolean", "string"],
        },
        default_value: {
          type: "string",
        },
      },
      required: ["name", "kind", "default_value"],
    },
  },
  {
    name: "delete_variable",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "rename_variable",
    inputSchema: {
      type: "object",
      properties: {
        old_name: {
          type: "string",
        },
        new_name: {
          type: "string",
        },
      },
      required: ["old_name", "new_name"],
    },
  },
  {
    name: "instantiate_component",
    inputSchema: {
      type: "object",
      properties: {
        component_id: {
          type: "string",
        },
      },
      required: ["component_id"],
    },
  },
  {
    name: "create_component",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
        name: {
          type: "string",
        },
      },
      required: ["node_id", "name"],
    },
  },
  {
    name: "delete_component",
    inputSchema: {
      type: "object",
      properties: {
        component_id: {
          type: "string",
        },
      },
      required: ["component_id"],
    },
  },
  {
    name: "rename_component",
    inputSchema: {
      type: "object",
      properties: {
        component_id: {
          type: "string",
        },
        name: {
          type: "string",
        },
      },
      required: ["component_id", "name"],
    },
  },
  {
    name: "set_active_page",
    inputSchema: {
      type: "object",
      properties: {
        index: {
          type: "string",
        },
      },
      required: ["index"],
    },
  },
  {
    name: "add_page",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
        },
        children: {
          type: "array",
          items: {
            type: "object",
          },
        },
      },
    },
  },
  {
    name: "rename_page",
    inputSchema: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
        },
        index: {
          type: "string",
        },
        name: {
          type: "string",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "delete_page",
    inputSchema: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
        },
        index: {
          type: "string",
        },
      },
    },
  },
  {
    name: "remove_page",
    inputSchema: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
        },
        index: {
          type: "string",
        },
      },
    },
  },
  {
    name: "duplicate_page",
    inputSchema: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
        },
        index: {
          type: "string",
        },
        name: {
          type: "string",
        },
      },
    },
  },
  {
    name: "reorder_page",
    inputSchema: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
        },
        index: {
          type: "string",
        },
        from: {
          type: "string",
        },
        to: {
          type: "string",
        },
      },
    },
  },
  {
    name: "set_active_axis_value",
    inputSchema: {
      type: "object",
      properties: {
        axis: {
          type: "string",
        },
        value: {
          type: "string",
        },
      },
      required: ["axis", "value"],
    },
  },
  {
    name: "insert_node",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: [
            "frame",
            "group",
            "rect",
            "ellipse",
            "polygon",
            "line",
            "text",
            "path",
          ],
        },
        name: {
          type: "string",
        },
        x: {
          type: "string",
        },
        y: {
          type: "string",
        },
        width: {
          type: "string",
        },
        height: {
          type: "string",
        },
        fill_hex: {
          type: "string",
        },
        parent: {
          type: "string",
        },
        data: {
          type: "object",
        },
        postProcess: {
          type: "boolean",
          default: false,
        },
        canvasWidth: {
          type: "number",
        },
        pageId: {
          type: "string",
        },
      },
    },
  },
  {
    name: "update_node",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
        nodeId: {
          type: "string",
        },
        x: {
          type: "string",
        },
        y: {
          type: "string",
        },
        width: {
          type: "string",
        },
        height: {
          type: "string",
        },
        name: {
          type: "string",
        },
        fill_hex: {
          type: "string",
        },
        data: {
          type: "object",
        },
        postProcess: {
          type: "boolean",
          default: false,
        },
        canvasWidth: {
          type: "number",
        },
        pageId: {
          type: "string",
        },
      },
    },
  },
  {
    name: "delete_node",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
        nodeId: {
          type: "string",
        },
        pageId: {
          type: "string",
        },
      },
    },
  },
  {
    name: "move_node",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
        nodeId: {
          type: "string",
        },
        target_parent_id: {
          type: "string",
        },
        parent: {
          type: "string",
        },
        index: {
          type: "string",
        },
        pageId: {
          type: "string",
        },
      },
    },
  },
  {
    name: "copy_node",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
        sourceId: {
          type: "string",
        },
        nodeId: {
          type: "string",
        },
        target_parent_id: {
          type: "string",
        },
        parent: {
          type: "string",
        },
        overrides: {
          type: "object",
        },
        pageId: {
          type: "string",
        },
      },
    },
  },
  {
    name: "replace_node",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
        },
        nodeId: {
          type: "string",
        },
        kind: {
          type: "string",
          enum: [
            "frame",
            "group",
            "rect",
            "ellipse",
            "polygon",
            "line",
            "text",
            "path",
          ],
        },
        name: {
          type: "string",
        },
        x: {
          type: "string",
        },
        y: {
          type: "string",
        },
        width: {
          type: "string",
        },
        height: {
          type: "string",
        },
        fill_hex: {
          type: "string",
        },
        data: {
          type: "object",
        },
        postProcess: {
          type: "boolean",
          default: false,
        },
        canvasWidth: {
          type: "number",
        },
        drop_children: {
          type: "string",
          enum: ["true", "false"],
        },
        dropChildren: {
          type: "string",
          enum: ["true", "false"],
        },
        pageId: {
          type: "string",
        },
      },
    },
  },
] as const;
