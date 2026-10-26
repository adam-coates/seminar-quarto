-- copy-poll-page.lua — put poll.html beside every rendered deck.
--
-- The QR code on a deck points at poll.html in the deck's own folder, and the
-- page reads its configuration out of the deck, so each rendered deck needs a
-- copy next to it, along with the socket.io client it loads
-- (livepoll-socket.io.min.js, from vendor/: no CDN, so phones contact no third
-- party). Run it as a project post-render script:
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

-- each file poll.html needs, by the name it has beside the deck
local files = {
  ["poll.html"] = "poll.html",
  ["livepoll-socket.io.min.js"] = "vendor/socket.io.min.js",
}
local contents = {}
for target, source in pairs(files) do
  contents[target] = read(here .. source)
  if not contents[target] then
    io.stderr:write("livepoll: " .. source .. " not found next to copy-poll-page.lua\n")
    os.exit(1)
  end
end

local outputs = os.getenv("QUARTO_PROJECT_OUTPUT_FILES") or ""
local copied = {}
for path in outputs:gmatch("[^\r\n]+") do
  local dir, name = path:match("^(.-)([^/\\]+)$")
  if name:match("%.html?$") and name ~= "poll.html" then
    local html = read(path)
    if html and html:find('id="livepoll-config"', 1, true) then
      local folder = dir ~= "" and dir or "./"
      if not copied[folder] then
        for target, data in pairs(contents) do
          local f = assert(io.open(folder .. target, "wb"))
          f:write(data)
          f:close()
        end
        copied[folder] = true
        print("livepoll: " .. folder .. "poll.html")
      end
    end
  end
end
