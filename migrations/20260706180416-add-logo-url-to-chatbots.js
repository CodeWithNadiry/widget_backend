export async function up(queryInterface, Sequelize) {
  await queryInterface.addColumn('chatbots', 'logoUrl', {
    type: Sequelize.STRING,
    allowNull: true,
  });
}

export async function down(queryInterface) {
  await queryInterface.removeColumn('chatbots', 'logoUrl');
}