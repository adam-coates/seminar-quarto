-- copy-poll-page.lua — put poll.html beside every rendered deck.
--
-- The QR code on a deck points at poll.html in the deck's own folder, and the
-- page reads its configuration out of the deck, so each rendered deck needs a
-- copy next to it. Run it as a project post-render script:
--
--     project:
--       post-render:
--         - _extensions/adam-coates/livepoll/copy-poll-page.lua
--
-- Copying on every render means the deployed page can never drift from the
-- extension's. Quarto lists what it just rendered in QUARTO_PROJECT_OUTPUT_FILES
-- (one path per line); only HTML files carrying livepoll's config block get a copy.

local here = debug.getinfo(1, "S").source:sub(2):match("(.*[/\\])") or "./"

local function read(path)
  local f = io.open(path, "rb")
  if not f then return nil end
  local data = f:read("a")
  f:close()
  return data
end

local page = read(here .. "poll.html")
if not page then
  io.stderr:write("livepoll: poll.html not found next to copy-poll-page.lua\n")
  os.exit(1)
end

local outputs = os.getenv("QUARTO_PROJECT_OUTPUT_FILES") or ""
local copied = {}
for path in outputs:gmatch("[^\r\n]+") do
  local dir, name = path:match("^(.-)([^/\\]+)$")
  if name:match("%.html?$") and name ~= "poll.html" then
    local html = read(path)
    if html and html:find('id="livepoll-config"', 1, true) then
      local target = (dir ~= "" and dir or "./") .. "poll.html"
      if not copied[target] then
        local f = assert(io.open(target, "wb"))
        f:write(page)
        f:close()
        copied[target] = true
        print("livepoll: " .. target)
      end
    end
  end
end
