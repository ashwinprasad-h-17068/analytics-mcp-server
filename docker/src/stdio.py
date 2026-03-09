import tools
from src.mcp_instance import mcp
from src.config import Settings

Settings.HOSTED_LOCATION = "LOCAL"


if __name__ == "__main__":
    mcp.run()