-- Left side of the window: server and agent pickers, and the grouped thread list.

local _, ns = ...
local UI = ns.UI

local L = {}
ns.ThreadList = L

local LIST_W_DEFAULT = 280

local GROUPS = {
	{ key = "working", label = "Working" },
	{ key = "open", label = "Open" },
}

local DOT_COLORS = {
	working = { 0.29, 0.62, 1 },
	input = { 1, 0.6, 0.2 },
	plan = { 1, 0.6, 0.2 },
	failed = { 1, 0.25, 0.25 },
	unread = { 0.29, 0.62, 1 },
}

local function InitHeader(button, ed)
	UI.InitGroupHeader(button)
	UI.SetGroupHeader(button, ed.label, ed.count, ed.collapsed)
	button:SetScript("OnClick", function()
		local c = ns.db.settings.collapsed
		c[ed.key] = not c[ed.key]
		PlaySound(c[ed.key] and SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_OFF or SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON)
		L:Refresh(true)
	end)
end

local function CreateRow(button)
	button:SetHeight(46)
	button:RegisterForClicks("LeftButtonUp")

	local hover = button:CreateTexture(nil, "HIGHLIGHT")
	hover:SetAtlas("Options_List_Hover")
	hover:SetAllPoints()
	hover:SetAlpha(0.5)

	local sel = button:CreateTexture(nil, "BACKGROUND")
	sel:SetAtlas("PetList-ButtonSelect")
	sel:SetPoint("TOPLEFT", -2, 2)
	sel:SetPoint("BOTTOMRIGHT", 2, -2)
	button.Selected = sel

	local dot = button:CreateTexture(nil, "ARTWORK")
	dot:SetTexture("Interface\\Buttons\\WHITE8X8")
	dot:SetSize(7, 7)
	dot:SetPoint("TOPLEFT", 6, -12)
	dot:SetMask("Interface\\CharacterFrame\\TempPortraitAlphaMask")
	button.Dot = dot

	local title = button:CreateFontString(nil, "ARTWORK", "GameFontNormal")
	title:SetPoint("TOPLEFT", 18, -7)
	title:SetPoint("RIGHT", -74, 0)
	title:SetJustifyH("LEFT")
	title:SetWordWrap(false)
	button.Title = title

	local status = button:CreateFontString(nil, "ARTWORK", "GameFontHighlightSmall")
	status:SetPoint("TOPRIGHT", -6, -8)
	status:SetJustifyH("RIGHT")
	button.Status = status

	local sub = button:CreateFontString(nil, "ARTWORK", "GameFontDisableSmall")
	sub:SetPoint("BOTTOMLEFT", 18, 8)
	sub:SetPoint("RIGHT", -60, 0)
	sub:SetJustifyH("LEFT")
	sub:SetWordWrap(false)
	button.Sub = sub

	local age = button:CreateFontString(nil, "ARTWORK", "GameFontDisableSmall")
	age:SetPoint("BOTTOMRIGHT", -6, 8)
	age:SetJustifyH("RIGHT")
	button.Age = age

	button:SetScript("OnEnter", function(self)
		local t = self.thread
		if not t then return end
		GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
		GameTooltip:SetText(t.title, 1, 0.82, 0, 1, true)
		GameTooltip:AddLine(ns.Store:ProjectLabel(t.p), 0.7, 0.7, 0.7)
		GameTooltip:AddLine(t.l or ns.Store.StatusText(t.s), 1, 1, 1, true)
		if t.br then GameTooltip:AddLine("Branch: " .. t.br, 0.6, 0.8, 1) end
		if t.m then
			local label = t.mi and ns.Store:ModelLabel(ns.Store.EnvOf(t.id), ns.Store.ModelKey(t.mi, t.m)) or t.m
			GameTooltip:AddLine(label, 0.6, 0.6, 0.6)
		end
		if t.last then
			GameTooltip:AddLine(" ")
			GameTooltip:AddLine(t.last, 0.9, 0.9, 0.9, true)
		end
		GameTooltip:Show()
	end)
	button:SetScript("OnLeave", function() GameTooltip:Hide() end)
	button.created = true
end

local function InitRow(button, ed)
	if not button.created then CreateRow(button) end
	local t = ed.thread
	button.thread = t
	button.Selected:SetShown(t.id == ns.viewId and ns.Main.mode ~= "new")
	button.Title:SetText(t.title)
	if t.s == "closed" then
		button.Title:SetTextColor(0.75, 0.75, 0.75)
	else
		button.Title:SetTextColor(NORMAL_FONT_COLOR:GetRGB())
	end
	local color = DOT_COLORS[t.s] or (t.un and DOT_COLORS.unread)
	button.Dot:SetShown(color ~= nil)
	if color then button.Dot:SetVertexColor(color[1], color[2], color[3]) end
	button.Status:SetText(ns.Color(ns.Store.StatusColor(t.s), ns.Store.StatusText(t.s)))
	local sub = t.ch and ns.Store:ChannelLabel(t) or ns.Store:ProjectLabel(t.p)
	if t.s == "working" or t.s == "input" then sub = t.l or sub end
	button.Sub:SetText(sub)
	if t.s == "working" and t.st then
		button.Age:SetText(ns.Duration(time() - t.st))
	else
		button.Age:SetText(ns.Ago(t.u))
	end
	button:SetScript("OnClick", function()
		PlaySound(SOUNDKIT.IG_QUEST_LOG_OPEN or SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON)
		ns.Main:SelectThread(t.id)
	end)
end

function L:Create(parent)
	self.parent = parent
	-- The server first: this computer, each OpenBot server, or all of them.
	local server = UI.Dropdown(parent, LIST_W_DEFAULT, function(value) L:PickServer(value) end)
	server:Hide()
	self.server = server

	local dd = UI.Dropdown(parent, LIST_W_DEFAULT, function(value)
		ns.db.settings.project = value
		L:Refresh(true)
		ns.Main:Refresh()
	end)
	self.dropdown = dd

	local search = CreateFrame("EditBox", nil, parent, "SearchBoxTemplate")
	search:SetHeight(20)
	search:SetPoint("TOPLEFT", dd, "BOTTOMLEFT", 6, -6)
	search:SetPoint("TOPRIGHT", dd, "BOTTOMRIGHT", -2, -6)
	search:SetAutoFocus(false)
	search:HookScript("OnTextChanged", function(box)
		L.query = strtrim(box:GetText() or ""):lower()
		L:Refresh(true)
	end)
	self.search = search

	local scrollBox = CreateFrame("Frame", nil, parent, "WowScrollBoxList")
	local scrollBar = CreateFrame("EventFrame", nil, parent, "MinimalScrollBar")
	scrollBar:SetPoint("TOPLEFT", scrollBox, "TOPRIGHT", 4, 0)
	scrollBar:SetPoint("BOTTOMLEFT", scrollBox, "BOTTOMRIGHT", 4, 0)

	local view = CreateScrollBoxListLinearView(2, 2, 2, 2, 2)
	view:SetElementFactory(function(factory, ed)
		if ed.header then
			factory("OpenBotGroupHeaderTemplate", InitHeader)
		elseif ed.empty then
			factory("OpenBotEmptyRowTemplate", function(frame)
				if not frame.Text then
					frame.Text = frame:CreateFontString(nil, "ARTWORK", "GameFontDisable")
					frame.Text:SetPoint("LEFT", 18, 0)
					frame.Text:SetPoint("RIGHT", -8, 0)
					frame.Text:SetJustifyH("LEFT")
				end
				-- A note (an offline server's error) takes up to three lines.
				frame.Text:SetMaxLines(ed.tall and 3 or 1)
				frame.Text:SetText(ed.empty)
			end)
		else
			factory("OpenBotThreadRowTemplate", InitRow)
		end
	end)
	view:SetElementExtentCalculator(function(_, ed)
		if ed.header then return 28 end
		if ed.empty then return ed.tall and 52 or 24 end
		return 46
	end)
	ScrollUtil.InitScrollBoxListWithScrollBar(scrollBox, scrollBar, view)
	self.scrollBox, self.scrollBar, self.view = scrollBox, scrollBar, view
	self:Layout(false)
end

-- The server picker shows once the bridge reports servers (it's signed in); the agent picker,
-- search and list move down under it.
function L:Layout(withServer)
	if self.laidOut == withServer then return end
	self.laidOut = withServer
	local parent, top = self.parent, -8
	self.server:SetShown(withServer)
	if withServer then
		self.server:ClearAllPoints()
		self.server:SetPoint("TOPLEFT", 8, top)
		self.server:SetPoint("TOPRIGHT", -10, top)
		top = top - 30
	end
	self.dropdown:ClearAllPoints()
	self.dropdown:SetPoint("TOPLEFT", 8, top)
	self.dropdown:SetPoint("TOPRIGHT", -10, top)
	self.scrollBox:ClearAllPoints()
	self.scrollBox:SetPoint("TOPLEFT", parent, "TOPLEFT", 4, top - 62)
	self.scrollBox:SetPoint("BOTTOMRIGHT", parent, "BOTTOMRIGHT", -18, 4)
end

function L:PickServer(value)
	local s = ns.db.settings
	s.server = value
	local e = value ~= "all" and ns.Store:Server(value)
	if e then s.serverLabel = ns.Store.ServerName(e) end
	-- The agent filter only keeps an agent on the new server.
	local p = s.project ~= "all" and ns.Store.projectsById[s.project]
	if p and value ~= "all" and ns.Store.ServerOf(p) ~= value then s.project = "all" end
	L:Refresh(true)
	ns.Main:Refresh()
	-- Tracker lines name servers other than the picked one, and it only redraws on new data.
	ns.Tracker:Refresh()
end

-- Filters saved before the server picker were "m:<label>" agent filters.
function L:MigrateFilter()
	local s = ns.db.settings
	local label = type(s.project) == "string" and s.project:match("^m:(.+)$")
	if not label then return end
	s.project = "all"
	if label == "local" then
		s.server = ""
		return
	end
	for _, e in ipairs(ns.Store:Servers() or {}) do
		if e.label == label then
			s.server, s.serverLabel = ns.Store.ServerCode(e), e.label
			return
		end
	end
end

local function Cap(text)
	return (text:gsub("^%l", string.upper))
end

function L:SetupServers()
	local servers = ns.Store:Servers()
	self:Layout(servers ~= nil)
	if not servers then return end
	local s = ns.db.settings
	local options = { { value = "all", label = "All servers" } }
	local found = s.server == nil or s.server == "all"
	for _, e in ipairs(servers) do
		local code = ns.Store.ServerCode(e)
		local name = Cap(ns.Store.ServerName(e))
		local state = e.state ~= "connected" and (e.state == "connecting" and "connecting…" or "offline") or nil
		table.insert(options, { value = code, label = name .. (state and ns.Color("orange", "  ·  " .. state) or ""), tip = e.err })
		if code == s.server then found = true end
	end
	-- A picked server that isn't reported now (removed, or the bridge is starting) stays listed.
	if not found then
		table.insert(options, { value = s.server, label = (s.serverLabel or "Server") .. ns.Color("orange", "  ·  not connected") })
	end
	self.server:SetOptions(options, s.server or "all")
	local e = ns.Store:SelectedServer() and ns.Store:Server(s.server)
	self.server.tipBody = (e and e.err) or "Pick a server: its agents and threads. Right-click or scroll to step."
end

function L:SetupDropdown()
	local server = ns.Store:SelectedServer()
	local options = { { value = "all", label = "All agents" } }
	local channels = {}
	for _, p in ipairs(ns.Store.data.projects) do
		if p.act and (server == nil or ns.Store.ServerOf(p) == server) then
			table.insert(p.ch and channels or options, { value = p.id, label = ns.Store:ProjectLabel(p.id) })
		end
	end
	-- Channels after the agents, under their own heading.
	if #channels > 0 then
		table.insert(options, { header = true, label = "Channels" })
		for _, o in ipairs(channels) do table.insert(options, o) end
	end
	self.dropdown:SetOptions(options, ns.Store:SelectedAgent() or "all")
end

-- The note at the top of a picked server that has no threads to show because it's not connected.
local function ServerNote(server)
	local e = ns.Store:Server(server)
	if e and e.state == "connected" then return nil end
	local name = e and Cap(ns.Store.ServerName(e)) or (ns.db.settings.serverLabel or "This server")
	if e and e.state == "connecting" then return ns.Color("orange", "Connecting to " .. name .. "…") end
	local text = ns.Color("orange", name .. " is offline.")
	if e and e.err then text = text .. " " .. e.err end
	return text .. ns.Color("grey", " Its threads come back when it reconnects.")
end

function L:Refresh(force)
	if not self.scrollBox then return end
	local s = ns.db.settings
	self:MigrateFilter()
	-- An agent that's gone from a connected server is forgotten; one on a server that's offline
	-- (or not reported yet) stays picked for when it's back.
	if s.project ~= "all" and not ns.Store.projectsById[s.project] and ns.Store.applied > 0 then
		local e = ns.Store:Server(ns.Store.EnvOf(s.project))
		if not ns.Store:Servers() or (e and e.state == "connected") then s.project = "all" end
	end
	local key = table.concat({
		ns.Store.listKey or "", s.project, tostring(s.server), tostring(s.collapsed.working), tostring(s.collapsed.open),
		tostring(ns.viewId), ns.Main.mode, self.query or "",
	}, ":")
	if key == self.key and not force then
		-- Only timers changed: refresh the visible rows in place.
		self.scrollBox:ForEachFrame(function(frame, ed)
			if ed.thread then InitRow(frame, ed) end
		end)
		return
	end
	self.key = key
	self:SetupServers()
	self:SetupDropdown()

	local server = ns.Store:SelectedServer()
	local groups = ns.Store:Groups(ns.Store:SelectedAgent() or "all", self.query, server)
	local dp = CreateDataProvider()
	local note = server and ns.Store.applied > 0 and ServerNote(server)
	local any = #groups.working + #groups.open > 0
	if note then dp:Insert({ empty = note, tall = true }) end
	for _, g in ipairs(note and not any and {} or GROUPS) do
		local list = groups[g.key]
		local collapsed = s.collapsed[g.key]
		do
			dp:Insert({ header = true, key = g.key, label = g.label, count = #list, collapsed = collapsed })
			if not collapsed then
				for _, t in ipairs(list) do dp:Insert({ thread = t }) end
				if #list == 0 then
					dp:Insert({ empty = g.key == "working" and "Nothing running" or "Nothing here" })
				end
			end
		end
	end
	if ns.Store.applied == 0 then
		dp:Insert({ empty = "Waiting for the bridge…" })
	end
	self.scrollBox:SetDataProvider(dp, ScrollBoxConstants.RetainScrollPosition)
	ns:Fire("ListRebuilt")
end
