"use strict";

// The editable spreadsheet used on the Mailing List's People and
// Organizations tabs. It knows how to draw and edit cells; the page decides
// what the rows are, what each cell holds, and what an edit changes.
//
//   const sheet = createSheet(host, {
//     columns,           // [{ key, label, width, type, sticky, readOnly, group, header, title, readOnlyMessage }]
//     cell(rowId, col),  // -> { value, problem, covered, shared, readOnly, readOnlyMessage, toggle } -- value is text, a number, or true/false for a flag
//     choices(col),      // suggestions while typing in a "choice" column
//     onChange(edits),   // [{ rowId, col, value }] -- one cell, or a pasted block
//     onUndo(), onSort(col), onSelectionChange(), emptyHtml(),
//     onToggle(rowId, col), // a cell with `toggle` ("open" or "closed") was clicked, or Enter/Space pressed on it
//   });
//   sheet.setView(rows) // [{ id, groupStart, groupSize, indexInGroup, className }] in display order
//
// Column types: text (the default), "flag" (a checkbox), "count" (a whole
// number) and "choice" (text with suggestions). A `group` column is one
// merged cell across a row group -- a household's address across the rows
// of everyone who lives there. Columns sharing a `header` are drawn under
// one heading -- a newsletter's Email, Mail and Copies. A cell can be
// read-only, or tinted as shared, on its own (`readOnly`, `shared`), when
// rows of different kinds share the columns -- an organization and the
// members listed under it.
//
// Only the rows in view are in the DOM at any time -- every row is the same
// height, so which ones are in view falls out of the scroll position -- which
// keeps a list of thousands as quick to scroll and filter as a short one.
(function () {
  const SELECT_COL_WIDTH = 38;
  const ROW_BUFFER = 12; // rows rendered above and below what's in view, so scrolling doesn't flash blank
  let sheetCount = 0;

  function cellText(value, col) {
    if (col.type === "flag") return value ? "Yes" : "No";
    return value === undefined || value === null ? "" : String(value);
  }

  window.createSheet = function createSheet(host, config) {
    const sheetId = `sheet${++sheetCount}`;
    let columns = [];
    let stickyWidth = 0;
    let view = [];
    let viewIndex = new Map();
    let rowHeight = 30;
    let renderedRange = { start: -1, end: -1 };
    let active = null; // { id, key } -- the selected cell; a merged cell belongs to its group's first row
    let editor = null; // { id, key, input, quick } -- the cell being typed in
    const selected = new Set();
    let lastTickedIndex = null;

    host.innerHTML = `
      <div class="sheet-scroll" tabindex="0">
        <table class="sheet"><colgroup></colgroup><thead></thead><tbody></tbody></table>
        <datalist id="${sheetId}-choices"></datalist>
        <div class="empty sheet-empty" style="display:none"></div>
      </div>
    `;
    const scroll = qs(".sheet-scroll", host);
    const table = qs("table", host);
    const thead = qs("thead", host);
    const body = qs("tbody", host);
    const choiceList = qs("datalist", host);

    const colIndex = (key) => columns.findIndex((c) => c.key === key);
    const colByKey = (key) => columns[colIndex(key)];

    // ---- header ----

    function setColumns(next) {
      if (editor) commitEdit();
      columns = next;
      let offset = SELECT_COL_WIDTH;
      for (const col of columns) {
        col.offset = offset;
        offset += col.width;
      }
      stickyWidth = SELECT_COL_WIDTH + columns.filter((c) => c.sticky).reduce((total, c) => total + c.width, 0);
      const pinned = columns.filter((c) => c.sticky);
      columns.forEach((c) => (c.stickyLast = c === pinned[pinned.length - 1]));
      table.style.width = `${offset}px`;
      qs("colgroup", table).innerHTML =
        `<col style="width:${SELECT_COL_WIDTH}px" />` + columns.map((col) => `<col style="width:${col.width}px" />`).join("");
      const stickyStyle = (col) => (col.sticky ? `style="left:${col.offset}px"` : "");
      const grouped = columns.some((c) => c.header);
      table.classList.toggle("has-groups", grouped);
      let groupRow = "";
      if (grouped) {
        groupRow = '<tr class="group-row"><th class="sel-col sticky" style="left:0"></th>';
        for (let i = 0; i < columns.length; i++) {
          const col = columns[i];
          let span = 1;
          while (col.header && columns[i + span]?.header === col.header) span++;
          groupRow += `<th colspan="${span}" class="${col.sticky ? "sticky" : ""} ${col.header ? "group-head" : ""}" ${stickyStyle(col)}>${escapeHtml(col.header || "")}</th>`;
          i += span - 1;
        }
        groupRow += "</tr>";
      }
      thead.innerHTML = `${groupRow}
        <tr class="label-row">
          <th class="sel-col sticky" style="left:0"><input type="checkbox" class="select-all" tabindex="-1" title="Select every row shown" /></th>
          ${columns
            .map(
              (col) =>
                `<th data-key="${escapeHtml(col.key)}" class="${col.sticky ? "sticky" : ""} ${col.stickyLast ? "sticky-last" : ""} ${col.type === "count" ? "num" : ""} ${col.type === "flag" ? "flag" : ""} ${col.group ? "group-col" : ""} ${col.header ? "under-group" : ""}"
                  ${stickyStyle(col)} title="${escapeHtml(col.title || `Sort by ${col.label}`)}">${escapeHtml(col.label)}<span class="sort-mark"></span></th>`
            )
            .join("")}
        </tr>`;
      if (active && colIndex(active.key) < 0) active = null;
      renderHeaderState();
      renderBody(true);
    }

    let sortMark = { key: null, dir: 1 };
    function setSortMark(key, dir) {
      sortMark = { key, dir };
      renderHeaderState();
    }

    function renderHeaderState() {
      qsa("th[data-key]", thead).forEach((th) => {
        qs(".sort-mark", th).textContent = sortMark.key === th.dataset.key ? (sortMark.dir === 1 ? " ▲" : " ▼") : "";
      });
      const all = qs(".select-all", thead);
      if (all) {
        all.checked = view.length > 0 && selected.size === view.length;
        all.indeterminate = selected.size > 0 && selected.size < view.length;
      }
    }

    // ---- rows ----

    function setView(rows, { toTop = false } = {}) {
      view = rows;
      viewIndex = new Map(view.map((row, i) => [row.id, i]));
      for (const id of selected) if (!viewIndex.has(id)) selected.delete(id);
      if (active && !viewIndex.has(active.id)) active = null;
      if (toTop) scroll.scrollTop = 0;
      const empty = qs(".sheet-empty", host);
      empty.style.display = view.length ? "none" : "block";
      if (!view.length) empty.innerHTML = config.emptyHtml?.() || "Nothing to show.";
      renderHeaderState();
      renderBody(true);
    }

    const isReadOnly = (id, col) => !!(col.readOnly || config.cell(id, col)?.readOnly);

    function cellHtml(row, col) {
      const info = config.cell(row.id, col) || {};
      const merged = col.group && row.groupSize > 1;
      const shared = merged || info.shared;
      const readOnly = col.readOnly || info.readOnly;
      const classes = ["cell"];
      if (col.type) classes.push(`cell-${col.type}`);
      if (col.sticky) classes.push("sticky");
      if (col.stickyLast) classes.push("sticky-last");
      if (readOnly) classes.push("cell-readonly");
      if (info.toggle) classes.push("cell-toggle");
      if (shared) classes.push("cell-shared");
      if (info.covered) classes.push("cell-covered");
      if (info.problem) classes.push("cell-problem");
      if (active && active.id === row.id && active.key === col.key) classes.push("cell-active");
      const attrs = [`data-key="${escapeHtml(col.key)}"`];
      if (col.sticky) attrs.push(`style="left:${col.offset}px"`);
      if (merged) attrs.push(`rowspan="${row.groupSize}"`);
      const title = info.problem || info.covered || (col.type ? "" : cellText(info.value, col));
      if (title) attrs.push(`title="${escapeHtml(title)}"`);
      const toggle = info.toggle ? `<span class="row-toggle">${info.toggle === "open" ? "▼" : "▶"}</span>` : "";
      const content =
        col.type === "flag"
          ? `<input type="checkbox" class="flag-box" tabindex="-1" ${info.value ? "checked" : ""} ${readOnly ? "disabled" : ""} />`
          : toggle + escapeHtml(cellText(info.value, col));
      return `<td class="${classes.join(" ")}" ${attrs.join(" ")}>${content}</td>`;
    }

    function rowHtml(row, index) {
      const isSelected = selected.has(row.id);
      const classes = [isSelected ? "row-selected" : "", row.className || ""];
      if (row.groupSize > 1) classes.push("in-group", row.indexInGroup === 0 ? "group-first" : "group-more");
      return `<tr data-id="${escapeHtml(row.id)}" data-index="${index}" class="${classes.join(" ")}">
        <td class="sel-col sticky" style="left:0"><input type="checkbox" class="row-select" tabindex="-1" ${isSelected ? "checked" : ""} /></td>
        ${columns.map((col) => (col.group && row.indexInGroup > 0 ? "" : cellHtml(row, col))).join("")}
      </tr>`;
    }

    function renderBody(force = false) {
      const headerHeight = thead.offsetHeight;
      const top = Math.max(0, scroll.scrollTop - headerHeight);
      const span = Math.ceil(scroll.clientHeight / rowHeight) + ROW_BUFFER * 2;
      // scrollTop can still be from a longer list than the one just filtered
      // down to, until the browser catches up; never start past the end.
      let start = Math.max(0, Math.min(Math.floor(top / rowHeight) - ROW_BUFFER, view.length - span));
      let end = Math.min(view.length, start + span);
      // Whole groups only, so a merged cell is never cut in half.
      if (view[start]) start = view[start].groupStart;
      if (end > 0) end = view[end - 1].groupStart + view[end - 1].groupSize;
      if (!force && start === renderedRange.start && end === renderedRange.end) return;
      if (editor) commitEdit();
      renderedRange = { start, end };
      const spacer = (rows) => `<tr class="sheet-spacer" style="height:${rows * rowHeight}px"><td colspan="${columns.length + 1}"></td></tr>`;
      body.innerHTML =
        (start > 0 ? spacer(start) : "") +
        view.slice(start, end).map((row, i) => rowHtml(row, start + i)).join("") +
        (end < view.length ? spacer(view.length - end) : "");

      // Rows are drawn at whatever height the stylesheet gives them; measure
      // it once rather than trusting a constant to match.
      const firstRow = body.querySelector("tr[data-id]");
      if (firstRow && firstRow.offsetHeight && firstRow.offsetHeight !== rowHeight) {
        rowHeight = firstRow.offsetHeight;
        renderBody(true);
      }
    }

    function rowElement(id) {
      return body.querySelector(`tr[data-id="${CSS.escape(id)}"]`);
    }

    // Redraws the groups these rows are in (all of a group's rows, for its
    // merged cells). A group with a cell open for typing is left alone --
    // closing the editor redraws it anyway.
    function refreshRows(ids) {
      const starts = new Set();
      for (const id of ids) {
        const index = viewIndex.get(id);
        if (index !== undefined) starts.add(view[index].groupStart);
      }
      for (const groupStart of starts) {
        const rows = view.slice(groupStart, groupStart + view[groupStart].groupSize);
        if (editor && rows.some((r) => r.id === editor.id)) continue;
        const first = rowElement(rows[0].id);
        if (!first) continue;
        rows.slice(1).forEach((r) => rowElement(r.id)?.remove());
        first.outerHTML = rows.map((r, i) => rowHtml(r, groupStart + i)).join("");
      }
    }

    // ---- the selected cell ----

    function activeCell() {
      if (!active) return null;
      return rowElement(active.id)?.querySelector(`td[data-key="${CSS.escape(active.key)}"]`) || null;
    }

    function scrollToActive() {
      const index = viewIndex.get(active.id);
      if (index === undefined) return;
      const rowTop = index * rowHeight; // below the sticky header
      const rowsVisible = scroll.clientHeight - thead.offsetHeight;
      if (rowTop < scroll.scrollTop) scroll.scrollTop = rowTop;
      else if (rowTop + rowHeight > scroll.scrollTop + rowsVisible) scroll.scrollTop = rowTop + rowHeight - rowsVisible;
      const col = colByKey(active.key);
      if (col && !col.sticky) {
        if (col.offset - stickyWidth < scroll.scrollLeft) scroll.scrollLeft = col.offset - stickyWidth;
        else if (col.offset + col.width > scroll.scrollLeft + scroll.clientWidth) scroll.scrollLeft = col.offset + col.width - scroll.clientWidth;
      }
      renderBody(); // the scroll event comes later; the row needs to exist now
    }

    function setActive(id, key, { scrollIntoView = true } = {}) {
      activeCell()?.classList.remove("cell-active");
      const index = viewIndex.get(id);
      const col = colByKey(key);
      if (!col) return;
      active = { id: index !== undefined && col.group ? view[view[index].groupStart].id : id, key };
      if (scrollIntoView) scrollToActive();
      activeCell()?.classList.add("cell-active");
    }

    function moveActive(rows, cols) {
      if (!view.length || !columns.length) return;
      if (!active) {
        setActive(view[0].id, columns[0].key);
        return;
      }
      let index = viewIndex.get(active.id) ?? 0;
      if (rows > 0 && colByKey(active.key)?.group) {
        // Down from a merged cell leaves the group it spans.
        const row = view[index];
        index = row.groupStart + row.groupSize - 1;
      }
      index = Math.min(view.length - 1, Math.max(0, index + rows));
      const ci = Math.min(columns.length - 1, Math.max(0, colIndex(active.key) + cols));
      setActive(view[index].id, columns[ci].key);
    }

    // ---- typing in a cell ----

    function change(edits) {
      if (edits.length) config.onChange(edits);
    }

    function toggleFlag(id, col) {
      if (isReadOnly(id, col)) return;
      change([{ rowId: id, col, value: !config.cell(id, col)?.value }]);
    }

    // `typed` starts the cell over with that character, as typing onto a
    // selected cell does in Excel; otherwise the cell opens with its value.
    function startEdit(typed) {
      if (!active) return;
      const col = colByKey(active.key);
      const info = config.cell(active.id, col) || {};
      if (info.toggle) {
        if (typed === undefined) config.onToggle?.(active.id, col);
        return;
      }
      if (col.readOnly || info.readOnly) {
        toast(info.readOnlyMessage || col.readOnlyMessage || `${col.label} can't be changed here.`);
        return;
      }
      if (col.type === "flag") {
        toggleFlag(active.id, col);
        return;
      }
      const td = activeCell();
      if (!td) return;
      td.classList.add("cell-editing");
      td.removeAttribute("title");
      const list = col.type === "choice" ? `list="${sheetId}-choices"` : "";
      if (col.type === "choice") choiceList.innerHTML = (config.choices?.(col) || []).map((c) => `<option value="${escapeHtml(c)}"></option>`).join("");
      td.innerHTML = `<input class="cell-editor" type="text" spellcheck="false" autocomplete="off" ${list} ${col.type === "count" ? 'inputmode="numeric"' : ""} />`;
      const input = td.querySelector("input");
      input.value = typed ?? cellText(config.cell(active.id, col)?.value, col);
      editor = { id: active.id, key: active.key, input, quick: typed !== undefined };
      input.focus();
      if (typed === undefined) input.select();
      input.addEventListener("blur", () => {
        if (editor && editor.input === input) commitEdit();
      });
    }

    function closeEditor() {
      const closed = editor;
      editor = null;
      refreshRows([closed.id]);
      scroll.focus({ preventScroll: true });
      return closed;
    }

    function commitEdit(move) {
      if (!editor) return;
      const { id, key, input } = editor;
      const col = colByKey(key);
      const raw = input.value;
      closeEditor();
      if (col.type === "count") {
        const text = raw.trim();
        if (text && !/^\d+$/.test(text)) toast(`${col.label} has to be a whole number, like 1 or 15.`, true);
        else change([{ rowId: id, col, value: text ? Math.min(Number(text), ContactRules.MAX_COPIES) : 0 }]);
      } else {
        change([{ rowId: id, col, value: raw.replace(/\s+/g, " ").trim() }]);
      }
      if (move) moveActive(move.rows, move.cols);
    }

    function cancelEdit() {
      if (editor) closeEditor();
    }

    function clearActiveCell() {
      if (!active) return;
      const col = colByKey(active.key);
      if (isReadOnly(active.id, col)) return;
      change([{ rowId: active.id, col, value: col.type === "flag" ? false : col.type === "count" ? 0 : "" }]);
    }

    // A block copied from Excel arrives as tab-separated lines. It fills
    // rightward and downward from the selected cell, over the rows as they're
    // shown right now; read-only columns are skipped over, not shifted past.
    function pasteBlock(text) {
      const lines = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").map((line) => line.split("\t"));
      const startRow = viewIndex.get(active.id);
      const startCol = colIndex(active.key);
      const edits = [];
      let unreadable = 0;
      lines.forEach((cells, r) => {
        const row = view[startRow + r];
        if (!row) return;
        cells.forEach((rawValue, c) => {
          const col = columns[startCol + c];
          if (!col || isReadOnly(row.id, col)) return;
          const value = rawValue.replace(/\s+/g, " ").trim();
          if (col.type === "flag") edits.push({ rowId: row.id, col, value: ContactRules.parseFlag(value) });
          else if (col.type === "count") {
            const n = value ? ContactRules.parseCopies(value) : 0;
            if (n === null) unreadable++;
            else edits.push({ rowId: row.id, col, value: n });
          } else edits.push({ rowId: row.id, col, value });
        });
      });
      change(edits);
      const missing = lines.length - (view.length - startRow);
      if (missing > 0) toast(`${plural(missing, "row")} of what you pasted went past the bottom of the list and weren't used.`, true);
      if (unreadable) toast(`${plural(unreadable, "cell")} that should hold a whole number didn't, and ${unreadable === 1 ? "was" : "were"} left as before.`, true);
    }

    // ---- row selection ----

    function tickRow(id, { range }) {
      const index = viewIndex.get(id);
      const nextState = !selected.has(id);
      if (range && lastTickedIndex !== null) {
        const [from, to] = [Math.min(lastTickedIndex, index), Math.max(lastTickedIndex, index)];
        for (let i = from; i <= to; i++) {
          if (nextState) selected.add(view[i].id);
          else selected.delete(view[i].id);
        }
        renderBody(true);
      } else {
        if (nextState) selected.add(id);
        else selected.delete(id);
        refreshRows([id]);
      }
      lastTickedIndex = index;
      selectionChanged();
    }

    function selectionChanged() {
      renderHeaderState();
      config.onSelectionChange?.();
    }

    function clearSelection() {
      selected.clear();
      selectionChanged();
      renderBody(true);
    }

    // ---- events ----

    // Mouse handling is on mousedown, not click: committing an open edit
    // redraws its row, and a click whose mousedown landed on the old row
    // would never arrive.
    body.addEventListener("mousedown", (e) => {
      if (editor && e.target === editor.input) return;
      const td = e.target.closest("td");
      const tr = td?.closest("tr[data-id]");
      if (!tr) return;
      e.preventDefault(); // no text-selection drag; focus is placed by hand below
      if (editor) commitEdit();
      const id = tr.dataset.id;
      if (td.classList.contains("sel-col")) {
        tickRow(id, { range: e.shiftKey });
      } else {
        const col = colByKey(td.dataset.key);
        setActive(id, col.key, { scrollIntoView: false });
        if (e.target.classList.contains("flag-box")) toggleFlag(id, col);
        else if (td.classList.contains("cell-toggle")) config.onToggle?.(id, col);
      }
      scroll.focus({ preventScroll: true });
    });
    // The checkboxes only show state; mousedown above already changed it.
    body.addEventListener("click", (e) => {
      if (e.target.matches("input[type=checkbox]")) e.preventDefault();
    });
    body.addEventListener("dblclick", (e) => {
      const td = e.target.closest("td.cell");
      if (td && !td.classList.contains("cell-flag") && !editor) startEdit();
    });

    scroll.addEventListener("keydown", (e) => {
      if (editor) {
        if (e.target !== editor.input) return;
        if (e.key === "Enter") {
          e.preventDefault();
          commitEdit({ rows: e.shiftKey ? -1 : 1, cols: 0 });
        } else if (e.key === "Tab") {
          e.preventDefault();
          commitEdit({ rows: 0, cols: e.shiftKey ? -1 : 1 });
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelEdit();
        } else if (editor.quick && (e.key === "ArrowUp" || e.key === "ArrowDown") && !editor.input.list) {
          // Typing straight onto a cell, the arrows move on, as in Excel;
          // after a double-click they move within the text instead. (In a
          // column with suggestions they pick a suggestion.)
          e.preventDefault();
          commitEdit({ rows: e.key === "ArrowUp" ? -1 : 1, cols: 0 });
        }
        return;
      }
      if (e.target !== scroll) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === "z") {
        e.preventDefault();
        config.onUndo?.();
        return;
      }
      if (ctrl || e.altKey) return; // leave Ctrl+C / Ctrl+V to the copy and paste events
      const pageRows = Math.max(1, Math.floor((scroll.clientHeight - thead.offsetHeight) / rowHeight) - 1);
      const moves = {
        ArrowUp: [-1, 0],
        ArrowDown: [1, 0],
        ArrowLeft: [0, -1],
        ArrowRight: [0, 1],
        PageUp: [-pageRows, 0],
        PageDown: [pageRows, 0],
        Home: [0, -columns.length],
        End: [0, columns.length],
      };
      if (moves[e.key]) {
        e.preventDefault();
        moveActive(...moves[e.key]);
        return;
      }
      if (!active) return;
      const col = colByKey(active.key);
      if (e.key === "Tab") {
        e.preventDefault();
        moveActive(0, e.shiftKey ? -1 : 1);
      } else if (e.key === "Enter" || e.key === "F2") {
        e.preventDefault();
        startEdit();
      } else if (e.key === "Escape") {
        // Lets Tab leave the spreadsheet again.
        activeCell()?.classList.remove("cell-active");
        active = null;
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        clearActiveCell();
      } else if (e.key === " " && col.type === "flag") {
        e.preventDefault();
        toggleFlag(active.id, col);
      } else if (e.key === " " && config.cell(active.id, col)?.toggle) {
        e.preventDefault();
        config.onToggle?.(active.id, col);
      } else if (e.key.length === 1 && (!col.type || col.type === "choice")) {
        e.preventDefault();
        startEdit(e.key);
      } else if (/^\d$/.test(e.key) && col.type === "count") {
        e.preventDefault();
        startEdit(e.key);
      }
    });

    // Copy and paste arrive at whatever element holds the page's text
    // selection (often a cell), not the focused grid, so check focus instead.
    scroll.addEventListener("copy", (e) => {
      if (editor || !active || document.activeElement !== scroll) return;
      e.preventDefault();
      const col = colByKey(active.key);
      e.clipboardData.setData("text/plain", cellText(config.cell(active.id, col)?.value, col));
    });
    scroll.addEventListener("paste", (e) => {
      if (editor || !active || document.activeElement !== scroll) return;
      const text = e.clipboardData.getData("text/plain");
      if (!text) return;
      e.preventDefault();
      pasteBlock(text);
    });

    thead.addEventListener("click", (e) => {
      if (e.target.closest(".select-all")) {
        e.preventDefault();
        const selectAll = selected.size < view.length;
        selected.clear();
        if (selectAll) view.forEach((row) => selected.add(row.id));
        selectionChanged();
        renderBody(true);
        return;
      }
      const th = e.target.closest("th[data-key]");
      if (th) config.onSort?.(colByKey(th.dataset.key));
    });

    scroll.addEventListener("scroll", () => renderBody());
    const onResize = () => {
      if (!document.body.contains(scroll)) window.removeEventListener("resize", onResize);
      else renderBody();
    };
    window.addEventListener("resize", onResize);

    setColumns(config.columns);

    return {
      element: scroll,
      get view() {
        return view;
      },
      selected,
      setColumns,
      setView,
      setSortMark,
      refreshRows,
      refreshAll: () => renderBody(true),
      // The layout changed around the sheet (a bar appeared above it).
      resized: () => renderBody(true),
      clearSelection,
      setActive,
      startEdit,
      commitEdit: () => commitEdit(),
      isEditing: () => !!editor,
      focus: () => scroll.focus({ preventScroll: true }),
      scrollToTop: () => {
        scroll.scrollTop = 0;
        scroll.scrollLeft = 0;
        renderBody(true);
      },
    };
  };
})();
