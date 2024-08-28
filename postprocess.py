from bs4 import BeautifulSoup


def inject_script_and_variable(html_content):
    soup = BeautifulSoup(html_content, "html.parser")

    # 1. Inject script tag into the head section
    script_tag = soup.new_tag(
        "script",
        src="https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.6.1/socket.io.js",
    )
    if soup.head:
        soup.head.append(script_tag)
    else:
        # If no head tag, create one and append it to the html
        head_tag = soup.new_tag("head")
        soup.html.insert(0, head_tag)
        head_tag.append(script_tag)

    # 2. Insert the JavaScript variable before a specific line
    script_tags = soup.find_all("script")
    for script in script_tags:
        if script.string and "Reveal.initialize({" in script.string:
            # Split the content of the script tag
            parts = script.string.split("Reveal.initialize({")
            # Add the new variable
            new_script_content = (
                "let isConnected = false;\n"
                + parts[0]
                + "Reveal.initialize({"
                + parts[1]
            )
            script.string = new_script_content
            break

    # 3. Inject additional code after the plugins array and before the final });
    for script in script_tags:
        if script.string and "Reveal.initialize({" in script.string:
            # Look for the end of the plugins array and the `});`
            start_index = script.string.find("plugins: [")
            if start_index != -1:
                end_index = script.string.find("]", start_index) + 1
                if end_index != -1:
                    # Additional code to insert
                    additional_code = """
      }).then(() => {
if (!isConnected) {
          // hide all elements that
          var showOnConnected =
            document.querySelectorAll(".seminar.connected") || [];
          for (var i = 0; i < showOnConnected.length; i++) {
            showOnConnected[i].style.display = "none";
          }
        }
      });
"""
                    # Insert the additional code
                    script.string = script.string[:end_index] + additional_code
            break

    # 4. Replace specific strings in the JavaScript content
    for script in script_tags:
        if script.string:
            # Replace "wooohoo" with seminarStatusLogger (no quotes)
            script.string = script.string.replace('"barfoo"', "seminarStatusLogger")
            # Replace "foobar" with getSeminarMenu() (no quotes)
            script.string = script.string.replace('"foobar"', "getSeminarMenu()")

    # 5. Remove specific redundant <script></script> tags
    # Convert the BeautifulSoup object to a string for easier manipulation
    html_str = str(soup)

    # Locate the specific pattern to remove the extra <script> tags
    pattern_to_remove = "</script>\n<script>\n    function getSeminarMenu() {"

    # Check if the pattern exists
    if pattern_to_remove in html_str:
        # Remove the extra <script></script> tags before the function declaration
        html_str = html_str.replace(
            pattern_to_remove, "\n    function getSeminarMenu() {", 1
        )

    return html_str


# Example usage
if __name__ == "__main__":
    # Load your HTML content from a file or other sources
    with open("index.html", "r", encoding="utf-8") as file:
        html_content = file.read()

    # Inject the custom JavaScript and HTML
    modified_html = inject_script_and_variable(html_content)

    # Save the modified HTML back to a file
    with open("index.html", "w", encoding="utf-8") as file:
        file.write(modified_html)

    print("HTML modification complete!")
