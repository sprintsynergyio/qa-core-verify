# Research

## Mutation Analysis for Assessing End-to-End Web Tests

Rahulkrishna Yandrapally and Ali Mesbah. Mutation Analysis for Assessing End-to-End Web Tests. 2021 IEEE International Conference on Software Maintenance and Evolution (ICSME), pages 183 to 194.

https://doi.org/10.1109/ICSME52107.2021.00023

The paper describes MAEWU, which mutates the DOM in the browser so an end-to-end suite can be assessed without application source code. qa-core-verify uses that idea for the fault-injection check: one fault is applied in the browser with `context.addInitScript` or `context.route`, and a test that stays green is reported. This checker is not MAEWU. It does not implement that paper's operators, and it does not claim the same results.
