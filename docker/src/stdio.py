import tools
from mcp_instance import mcp
from config import Settings

Settings.HOSTED_LOCATION = "LOCAL"


if __name__ == "__main__":
    mcp.run()