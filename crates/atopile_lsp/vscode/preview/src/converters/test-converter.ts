import { AtopileNetlistConverter } from './AtopileNetlistConverter';

/**
 * A simple test function to demonstrate the converter
 * This is not meant to be used in production, just for testing
 */
export function testConverter(netlistData: any): void {
  try {
    console.log('Testing Atopile Netlist Converter');
    
    const converter = new AtopileNetlistConverter();
    const hierarchicalSchematic = converter.convert(netlistData);
    
    // Log some basic information about the schematic
    console.log(`Converted schematic has ${Object.keys(hierarchicalSchematic.levels).length} levels`);
    console.log(`Current level ID: ${hierarchicalSchematic.currentLevelId}`);
    
    // Get the current level
    const currentLevel = converter.getLevel(hierarchicalSchematic, hierarchicalSchematic.currentLevelId);
    console.log(`Current level "${currentLevel.name}" has ${currentLevel.components.length} components and ${currentLevel.connections.length} connections`);
    
    // Log components in the current level
    console.log('Components in current level:');
    currentLevel.components.forEach(component => {
      console.log(` - ${component.name} (${component.type}) with ${component.ports.length} ports`);
      if (component.hasChildren) {
        console.log(`   This component has children and can be expanded`);
      }
    });
    
    // If there are child levels, navigate to the first one
    if (currentLevel.children && currentLevel.children.length > 0) {
      const childId = currentLevel.children[0];
      console.log(`Navigating to child level: ${childId}`);
      
      const newSchematic = converter.navigateToChild(hierarchicalSchematic, childId);
      const childLevel = converter.getLevel(newSchematic, newSchematic.currentLevelId);
      
      console.log(`Child level "${childLevel.name}" has ${childLevel.components.length} components and ${childLevel.connections.length} connections`);
      
      // Navigate back to parent
      console.log('Navigating back to parent level');
      const backToParent = converter.navigateToParent(newSchematic);
      console.log(`Back to level: ${backToParent.currentLevelId}`);
    }
    
    console.log('Converter test completed successfully');
  } catch (error) {
    console.error('Error testing converter:', error);
  }
}