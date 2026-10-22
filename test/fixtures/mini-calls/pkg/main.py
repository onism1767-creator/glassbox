from other.tool import helper as h, Tool
import other.tool as ot
from other import Tool as ReTool


def main():
    h()
    ot.helper()
    t = Tool()
    t.run()
    ReTool()
    unknown()
    return t


class App:
    def go(self):
        self.main2()
        self.inherited()

    def main2(self):
        return main()


main()
print("x")
